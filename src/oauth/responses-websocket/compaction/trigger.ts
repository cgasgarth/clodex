import { ResponsesCompactionError } from '../../responses-compaction.js';
import {
  RESPONSES_WS_STREAM_HIGH_WATER_MARK_BYTES,
  type JsonObject,
  type JsonValue,
  type RequestContext,
  type ConnectionEntry,
} from '../types.js';
import type { PromptFieldHashes } from '../fingerprint.js';
import { connectionEntries } from '../state.js';
import { inputArray } from '../fingerprint.js';
import { conversationItemKind, isOpaqueCompactionKind } from '../continuation.js';
import { expectedAssistantItems, closeContext } from '../protocol.js';
import { outgoingPayload, dispatchContext, deleteEntry } from '../transport.js';

interface CompactionTriggerOptions {
  entry: ConnectionEntry;
  delta: JsonValue[];
  compactTimeoutMs: number;
  payload: JsonObject;
  promptFieldHashes: PromptFieldHashes;
  instructionsSnapshot?: string;
  partitionKey?: string;
  diagnostic?: (event: { event: string } & JsonObject) => void;
  createReplacement: () => ConnectionEntry;
  signal?: AbortSignal | null;
}

interface CompactionTriggerResult {
  output: JsonValue[];
  usage?: import('../protocol.js').ResponseUsage;
  triggerWireBytes: number;
}

export async function runCompactionTrigger({
  entry,
  delta,
  compactTimeoutMs,
  payload,
  promptFieldHashes,
  instructionsSnapshot,
  partitionKey,
  diagnostic,
  createReplacement,
  signal,
}: CompactionTriggerOptions): Promise<CompactionTriggerResult> {
      if (!entry.responseId) {
        throw new ResponsesCompactionError('Native compaction trigger requires a live response chain');
      }
      const trigger = { type: 'compaction_trigger' };
      const triggerPayload: JsonObject = {
        ...payload,
        input: [...inputArray(payload), trigger],
      };
      delete triggerPayload.previous_response_id;
      const triggerSendPayload = {
        ...payload,
        input: [...delta, trigger],
        previous_response_id: entry.responseId,
      };
      const triggerWireBytes = Buffer.byteLength(outgoingPayload(triggerSendPayload), 'utf8');
      let ctx: RequestContext | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const hiddenContext: RequestContext = {
            controller,
            encoder: new TextEncoder(),
            originalPayload: triggerPayload,
            sendPayload: triggerSendPayload,
            retryPayload: triggerPayload,
            promptFieldHashes,
            instructionsSnapshot,
            continued: true,
            retried: false,
            closed: false,
            frameCount: 0,
            pendingEvents: [],
            emittedModelData: false,
            transportRetryPending: false,
            overflowRecoveryPending: false,
            overflowRetried: false,
            outputByIndex: new Map(),
            outputIndexByItemId: new Map(),
            emitDiagnostic: diagnostic,
            createReplacement,
          };
          ctx = hiddenContext;
          dispatchContext(entry, hiddenContext);
          if (signal) {
            const abort = () => {
              if (hiddenContext.closed) return;
              if (hiddenContext.entry) deleteEntry(hiddenContext.entry);
              closeContext(hiddenContext);
            };
            if (signal.aborted) abort();
            else {
              signal.addEventListener('abort', abort, { once: true });
              hiddenContext.abortCleanup = () => signal.removeEventListener('abort', abort);
            }
          }
        },
        cancel() {
          if (!ctx || ctx.closed) return;
          if (ctx.entry) deleteEntry(ctx.entry);
          closeContext(ctx);
        },
        pull() {
          ctx?.entry?.socket.resume();
        },
      }, {
        highWaterMark: RESPONSES_WS_STREAM_HIGH_WATER_MARK_BYTES,
        size: chunk => chunk?.byteLength ?? 0,
      });
      let timedOut = false;
      const didTimeOut = () => timedOut;
      const compactTimer = setTimeout(() => {
        timedOut = true;
        if (!ctx || ctx.closed) return;
        if (ctx.entry) deleteEntry(ctx.entry);
        closeContext(ctx);
      }, compactTimeoutMs);
      compactTimer.unref();
      try {
        await new Response(stream).arrayBuffer();
      } finally {
        clearTimeout(compactTimer);
      }
      if (didTimeOut()) {
        throw new ResponsesCompactionError(
          `Native compaction trigger exceeded ${Math.round(compactTimeoutMs / 1000)}s`,
          undefined,
          ctx?.responseUsage,
        );
      }
      const completedEntry = ctx?.entry;
      if (!ctx?.responseId) {
        throw new ResponsesCompactionError(
          'Native compaction trigger did not complete',
          undefined,
          ctx?.responseUsage,
        );
      }
      const output = expectedAssistantItems(ctx)
        .filter(item => isOpaqueCompactionKind(conversationItemKind(item)));
      if (completedEntry && connectionEntries(partitionKey).includes(completedEntry)) {
        // The trigger advances the connection-local previous-response slot, so
        // the pre-trigger response id is no longer usable. Its canonical
        // compact checkpoint remains a valid fallback until the rebased
        // response establishes a newer checkpoint.
        deleteEntry(completedEntry);
      }
      if (output.length !== 1) {
        throw new ResponsesCompactionError(
          `Native compaction trigger returned ${output.length} compaction items`,
          undefined,
          ctx.responseUsage,
        );
      }
      return { output, usage: ctx.responseUsage, triggerWireBytes };
}
