import {
  compactResponsesWindow,
  ResponsesCompactionError,
} from '../../responses-compaction.js';
import {
  estimatedRebasedInputTokens,
  recentDependencySafeWindow,
  type ResponsesOverflowRecoverySession,
} from '../../responses-overflow-recovery.js';
import { RESPONSES_CHECKPOINT_MISS_FALLBACK_TOKENS } from '../types.js';
import type { JsonObject, JsonValue } from '../types.js';

interface MissedResponsesState {
  lastInputTokens?: number;
  lastUsedAt: number;
}

interface RecoverCheckpointMissOptions {
  requestUrl: string | URL | Request;
  headers: HeadersInit | undefined;
  payload: JsonObject;
  states: MissedResponsesState[];
  estimatedInputTokens: number;
  contextWindow: number;
  overflowRecovery: ResponsesOverflowRecoverySession;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now: () => number;
  diagnostic: (event: { event: string } & JsonObject) => void;
}

export interface CheckpointMissRecovery {
  input: JsonValue[];
  estimatedInputTokens: number;
  endpointNotFound: boolean;
}

/** Compact only a recent state-sized window after a history/checkpoint miss. */
export async function recoverCheckpointMiss({
  requestUrl,
  headers,
  payload,
  states,
  estimatedInputTokens,
  contextWindow,
  overflowRecovery,
  fetch,
  signal,
  now,
  diagnostic,
}: RecoverCheckpointMissOptions): Promise<CheckpointMissRecovery | undefined> {
  const rememberedState = states
    .filter(state => state.lastInputTokens !== undefined)
    .toSorted((left, right) => right.lastUsedAt - left.lastUsedAt)[0];
  const targetInputTokens = rememberedState?.lastInputTokens
    ?? RESPONSES_CHECKPOINT_MISS_FALLBACK_TOKENS;
  const recentWindow = recentDependencySafeWindow(
    Array.isArray(payload.input) ? payload.input : [],
    targetInputTokens,
    contextWindow,
    estimatedInputTokens,
  );
  if (!recentWindow) return undefined;
  const claim = overflowRecovery.claimCompactionCall();
  if (!claim.ok) return undefined;

  const startedAt = now();
  diagnostic({
    event: 'ws_compaction',
    outcome: 'started',
    transport: 'responses_compact_endpoint',
    mode: 'checkpoint_miss',
    reason: 'known_oversized',
    source: rememberedState ? 'stored_input_tokens' : 'default_input_tokens',
    targetInputTokens: recentWindow.targetInputTokens,
    estimatedInputTokens: recentWindow.estimatedInputTokens,
    sourceItems: recentWindow.input.length,
    droppedItems: recentWindow.droppedItems,
    compactCallAttempt: claim.attempt,
  });

  try {
    const compactPayload: JsonObject = { ...payload, input: recentWindow.input };
    delete compactPayload.previous_response_id;
    const result = await compactResponsesWindow({
      requestUrl,
      headers,
      payload: compactPayload,
      fetch,
      signal,
      timeoutMs: claim.timeoutMs,
    });
    overflowRecovery.recordExternalCompaction(undefined, result.usage);
    const rebasedEstimate = estimatedRebasedInputTokens(
      result.output,
      [],
      recentWindow.input,
      recentWindow.estimatedInputTokens,
      result.usage?.outputTokens,
    );
    if (rebasedEstimate < contextWindow) {
      diagnostic({
        event: 'ws_compaction',
        outcome: 'completed',
        transport: 'responses_compact_endpoint',
        mode: 'checkpoint_miss',
        reason: 'known_oversized',
        durationMs: Math.max(0, now() - startedAt),
        targetInputTokens: recentWindow.targetInputTokens,
        estimatedInputTokens: recentWindow.estimatedInputTokens,
        compactedItems: result.output.length,
        ...result.usage,
      });
      return {
        input: result.output,
        estimatedInputTokens: rebasedEstimate,
        endpointNotFound: false,
      };
    }
    diagnostic({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'responses_compact_endpoint',
      mode: 'checkpoint_miss',
      reason: 'known_oversized',
      fallback: 'bounded_recent_window',
      skipReason: 'compacted_output_exceeds_context',
      durationMs: Math.max(0, now() - startedAt),
      targetInputTokens: recentWindow.targetInputTokens,
      estimatedInputTokens: recentWindow.estimatedInputTokens,
      sourceItems: recentWindow.input.length,
      droppedItems: recentWindow.droppedItems,
    });
    return {
      input: recentWindow.input,
      estimatedInputTokens: recentWindow.estimatedInputTokens,
      endpointNotFound: false,
    };
  } catch (error) {
    if (!(error instanceof ResponsesCompactionError)) throw error;
    overflowRecovery.recordExternalCompaction(error, error.usage);
    diagnostic({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'responses_compact_endpoint',
      mode: 'checkpoint_miss',
      reason: 'known_oversized',
      fallback: 'bounded_recent_window',
      durationMs: Math.max(0, now() - startedAt),
      statusCode: error.statusCode,
      failureClass: error.failureClass,
      targetInputTokens: recentWindow.targetInputTokens,
      estimatedInputTokens: recentWindow.estimatedInputTokens,
      sourceItems: recentWindow.input.length,
      droppedItems: recentWindow.droppedItems,
    });
    return {
      input: recentWindow.input,
      estimatedInputTokens: recentWindow.estimatedInputTokens,
      endpointNotFound: error.statusCode === 404,
    };
  }
}
