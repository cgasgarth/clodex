import { ResponsesCompactionError } from '../../responses-compaction.js';
import type { ConnectionEntry, JsonObject, JsonValue, RequestContext } from '../types.js';
import {
  boundedDiagnosticIdentifier,
  emitContextDiagnostic,
} from '../protocol.js';
import {
  deleteEntry,
  dispatchContext,
  failContext,
  resetContextForRetry,
} from '../transport.js';

interface OverflowRetryState {
  retryPayload?: JsonObject;
  compactedInputBase?: JsonValue[];
  attemptCount: number;
}

interface OverflowRecoveryHandlerOptions {
  contextWindow?: number;
  recover: () => Promise<boolean>;
  retryState: () => OverflowRetryState;
}

function compactionFailureStatus(error: ResponsesCompactionError): number {
  return error.statusCode ?? (error.failureClass === 'timeout_or_transport' ? 504 : 502);
}

export function createOverflowRecoveryHandler(
  options: OverflowRecoveryHandlerOptions,
): (entry: ConnectionEntry, ctx: RequestContext) => Promise<void> {
  return async (entry, ctx) => {
    const contextIsClosed = () => ctx.closed;
    if (ctx.closed || entry.current !== ctx || ctx.emittedModelData || ctx.overflowRetried) return;
    let recovered = false;
    let recoveryFailure: ResponsesCompactionError | undefined;
    try {
      recovered = await options.recover();
    } catch (error) {
      if (error instanceof ResponsesCompactionError) recoveryFailure = error;
      emitContextDiagnostic(entry, ctx, {
        event: 'ws_overflow_recovery',
        outcome: 'internal_failure',
        reason: 'response_context_rejection',
        errorType: boundedDiagnosticIdentifier(error instanceof Error ? error.name : 'UnknownError'),
      });
    }
    if (contextIsClosed() || entry.current !== ctx) return;
    const state = options.retryState();
    if (recoveryFailure) {
      const status = compactionFailureStatus(recoveryFailure);
      ctx.overflowRecoveryPending = false;
      ctx.overflowRetried = true;
      failContext(entry, ctx, recoveryFailure.message, {
        source: 'overflow_recovery',
        reason: 'non_context_compaction_failure',
        mappedStatusCode: status,
        failureClass: recoveryFailure.failureClass,
        errorCode: recoveryFailure.errorCode,
        providerErrorType: recoveryFailure.errorType,
        errorFingerprint: recoveryFailure.errorFingerprint,
        attemptCount: state.attemptCount,
      }, status);
      return;
    }
    if (!recovered || !state.retryPayload || !state.compactedInputBase) {
      ctx.overflowRecoveryPending = false;
      ctx.overflowRetried = true;
      failContext(
        entry,
        ctx,
        'OpenAI rejected the request for context length and no dependency-safe native recovery succeeded',
        {
          source: 'overflow_recovery',
          errorCode: 'context_length_exceeded',
          mappedStatusCode: 400,
          attemptCount: state.attemptCount,
          contextWindow: options.contextWindow,
        },
        400,
      );
      return;
    }

    ctx.retryPayload = state.retryPayload;
    ctx.compactedInputBase = state.compactedInputBase;
    ctx.establishCompactionRearm = true;
    ctx.postCompactionInputTokens = undefined;
    ctx.nextCompactionInputTokens = undefined;
    ctx.overflowRecoveryPending = false;
    ctx.overflowRetried = true;
    ctx.retried = true;
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_overflow_recovery',
      outcome: 'replaying',
      reason: 'response_context_rejection',
      attemptCount: state.attemptCount,
      contextWindow: options.contextWindow,
    });
    deleteEntry(entry);
    if (contextIsClosed()) return;
    resetContextForRetry(ctx);
    dispatchContext(ctx.createReplacement(), ctx);
  };
}
