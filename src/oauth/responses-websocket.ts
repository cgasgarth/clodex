import { randomUUID } from 'node:crypto';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { outboundProxyUrlForTarget } from '../transport/outbound-proxy.js';
import { loadBunNativeWebSocket } from '../transport/bun-websocket.js';
import { isBigInt, isBoolean, isFunction, isNumber, isObject, isString, isSymbol, isUndefined } from '../runtime/type-guards.js';
import {
  compactResponsesWindow,
  resolveOpenAiCompactionRearmThreshold,
  ResponsesCompactionError,
  type ResponsesCompactionUsage,
} from './responses-compaction.js';
import {
  approximateResponsesItemsTokens,
  estimatedRebasedInputTokens,
  ResponsesOverflowRecoverySession,
  type OverflowRecoveryReason,
  type OverflowRecoverySource,
} from './responses-overflow-recovery.js';
import {
  RESPONSES_COMPACTION_CHECKPOINT_TTL_MS,
  RESPONSES_COMPACTION_DURABLE_CHECKPOINT_TTL_MS,
  diagnosticContext,
} from './responses-websocket/types.js';
import type {
  ResponsesWebSocketDiagnosticEvent,
  JsonObject,
  JsonValue,
  RequestContext,
  ConnectionEntry,
  HydratedCompactionCheckpoint,
} from './responses-websocket/types.js';
import type {
  ResponsesWebSocketFetchOptions,
} from './responses-websocket/api/public.js';
import {
  allocateLineageDebugId,
  peekNextConnectionDebugId,
  connectionEntries,
  connectionCount,
  connectionCountByGeneration,
  checkpointEntries,
  persistCompactionCheckpoint,
  syntheticClaudeCompactionSummary,
  syntheticAssistantMessage,
  syntheticClaudeCompactionResponse,
  loadCompactionCheckpointStore,
  hydrateCompactionCheckpoint,
  debugKey,
  emitDiagnostic,
} from './responses-websocket/state.js';
import {
  changedPromptFields,
  instructionChangeSummary,
  inputArray,
} from './responses-websocket/fingerprint.js';
import {
  conversationItemKind,
  retainedUserMessages,
  compactionSummaryHash,
  conversationItemHash,
} from './responses-websocket/continuation.js';
import {
  finalizeResponsesSession,
  planResponsesSessionHead,
  responsesSessionDecisionMetadata,
  type ResponsesSessionDecision,
} from './responses-websocket/session-planner.js';
import { boundedDiagnosticIdentifier, closeContext } from './responses-websocket/protocol.js';
import {
  beginRecycledLineage,
  deleteEntry,
  cleanupExpiredConnections,
  evictOldestIdleGeneration,
  reusableCacheAffinityHead,
  dispatchContext,
  createConnection,
} from './responses-websocket/transport.js';
import { createOverflowRecoveryHandler } from './responses-websocket/overflow/recovery-handler.js';
import { runCompactionTrigger } from './responses-websocket/compaction/trigger.js';
import {
  checkpointStoreDirectory,
  prepareResponsesRequest,
  resolveWebSocketOptions,
} from './responses-websocket/request/setup.js';

export * from './responses-websocket/api/public.js';

function runtimeTypeName<Value>(value: Value): string {
  if (value instanceof Error) return value.name;
  if (isUndefined(value)) return 'undefined';
  if (isString(value)) return 'string';
  if (isNumber(value)) return 'number';
  if (isBoolean(value)) return 'boolean';
  if (isBigInt(value)) return 'bigint';
  if (isSymbol(value)) return 'symbol';
  if (isFunction(value)) return 'function';
  return 'object';
}

/**
 * Build a fetch transport backed by persistent, session-aware Responses sockets.
 * Each returned Response still represents exactly one AI SDK request.
 */
export function createResponsesWebSocketFetch(
  wsUrl: string,
  log?: (message: string) => void,
  options: ResponsesWebSocketFetchOptions = {},
): FetchFunction {
  const debug = (message: string) => { try { log?.(`ws: ${message}`); } catch { /* ignore */ } };
  let standaloneCompactionNotFound = false;
  const resolvedOptions = resolveWebSocketOptions(options);
  // Durable native state must never remain active after the user disables the
  // native compaction opt-in, even if a caller accidentally supplies a path.
  const checkpointStoreDir = checkpointStoreDirectory(options);

  // SAFETY: This async implementation matches the provider-utils FetchFunction contract.
  return (async (requestUrl, init): Promise<Response> => {
    const WebSocket = options.webSocketConstructor
      ?? loadBunNativeWebSocket();
    const proxyUrl = outboundProxyUrlForTarget(wsUrl);
    const {
      headers,
      payload,
      partitionKey,
      checkpointKey,
      promptFingerprint,
      promptFieldHashes,
      instructionsSnapshot,
    } = prepareResponsesRequest(wsUrl, init, options);
    const diagnosticCorrelation = diagnosticContext.getStore();
    const now = resolvedOptions.now();
    loadCompactionCheckpointStore(checkpointStoreDir, now, checkpointKey);
    const evictions = cleanupExpiredConnections(now);

    const forceCompaction = diagnosticCorrelation?.forceCompaction === true;
    const candidates = partitionKey ? connectionEntries(partitionKey) : [];
    const checkpoints = checkpointKey ? checkpointEntries(checkpointKey) : [];
    const headPlan = planResponsesSessionHead({
      payload,
      candidates,
      checkpoints,
      now,
      forceCompaction,
      claudeAgentId: diagnosticCorrelation?.claudeAgentId,
      hydrateCheckpoint: hydrateCompactionCheckpoint,
    });
    const {
      preparedConversation,
      diagnosticEntry,
      compactionEnvelopeCount,
      anchored,
    } = headPlan;
    let {
      selected,
      selectedMatch,
      selectedDelta,
      selectedCheckpoint,
      checkpointMatch,
    } = headPlan;
    const hasCompacted = () => compacted;
    if (headPlan.missedCompactionAnchor) {
      emitDiagnostic(options, {
        event: 'ws_compaction',
        outcome: 'anchor_missed',
        reason: 'claude_compaction_summary',
        envelopeCount: compactionEnvelopeCount,
      }, diagnosticCorrelation);
    }
    debug(
      `lookup key=${debugKey(partitionKey)} prompt=${debugKey(promptFingerprint)} hit=${candidates.length > 0} heads=${candidates.length} active_connections=${connectionCount()}`,
    );
    const promptChanges = changedPromptFields(diagnosticEntry?.promptFieldHashes, promptFieldHashes);
    if (promptChanges.length) debug(`prompt fields changed: ${promptChanges.join(',')}`);
    if (promptChanges.includes('instructions')) {
      const summary = instructionChangeSummary(diagnosticEntry?.instructionsSnapshot, instructionsSnapshot);
      if (summary) debug(summary);
    }
    let sendPayload = payload;
    let retryPayload: JsonObject | undefined;
    let compactedInputBase: JsonValue[] | undefined;
    let supersededEntry: ConnectionEntry | undefined;
    let continued = false;
    let persistent = Boolean(partitionKey);
    let decision: ResponsesSessionDecision = partitionKey
        ? 'new_partition_head'
        : 'unpartitioned_socket';
    const compactThreshold = options.compactThreshold;
    const contextWindow = options.contextWindow;
    const measuredInputTokens = selected?.lastInputTokens ?? selectedCheckpoint?.lastInputTokens;
    const estimatedInputTokens = diagnosticCorrelation?.estimatedInputTokens;
    const rearmSource = selected?.compactedInput ? selected : selectedCheckpoint;
    const persistedPostCompactionInputTokens = rearmSource?.postCompactionInputTokens;
    const persistedNextCompactionInputTokens = rearmSource?.nextCompactionInputTokens;
    // Older checkpoints have no rearm metadata. Treat their latest measured
    // compacted input as a provisional floor so an upgrade cannot immediately
    // re-enter the loop this guard fixes. The next successful response records
    // an exact post-compaction baseline.
    const provisionalPostCompactionInputTokens = persistedPostCompactionInputTokens
      ?? (persistedNextCompactionInputTokens === undefined ? rearmSource?.lastInputTokens : undefined);
    const effectiveCompactThreshold = compactThreshold === undefined
      ? undefined
      : Math.max(
          compactThreshold,
          persistedNextCompactionInputTokens
            ?? (provisionalPostCompactionInputTokens === undefined
              ? compactThreshold
              : resolveOpenAiCompactionRearmThreshold(
                  compactThreshold,
                  provisionalPostCompactionInputTokens,
                  contextWindow,
                )),
        );
    const compactionReason = forceCompaction
      ? 'claude_compaction_request'
      : effectiveCompactThreshold !== undefined
        && measuredInputTokens !== undefined
        && measuredInputTokens >= effectiveCompactThreshold
        ? 'measured_threshold'
        : compactThreshold !== undefined
          && !selected?.compactedInput
          && !selectedCheckpoint
          && estimatedInputTokens !== undefined
          && estimatedInputTokens >= compactThreshold
          ? 'estimated_threshold'
          : undefined;
    let compacted = false;
    let compactionUsage: ResponsesCompactionUsage | undefined;
    let failedTriggerCompactedInput: JsonValue[] | undefined;
    let terminalOverflowReason: string | undefined;
    let terminalRecoveryFailure: ResponsesCompactionError | undefined;
    let overflowRebasedEstimate: number | undefined;
    const overflowSources = (): OverflowRecoverySource[] => {
      const sources: OverflowRecoverySource[] = [];
      if (
        selected
        && selectedMatch
        && selected.requestInput
        && selected.expectedAssistant
      ) {
        const assistantCount = selected.expectedAssistant.length;
        const prefix = selected.compactedInput && selected.compactedInput.length >= assistantCount
          ? selected.compactedInput.slice(0, selected.compactedInput.length - assistantCount)
          : selected.requestInput;
        sources.push({
          kind: 'live_head',
          prefix,
          tail: [...selected.expectedAssistant, ...selectedMatch.delta],
          prefixInputTokens: selected.lastInputTokens,
        });
      }
      if (selectedCheckpoint && checkpointMatch) {
        const assistantCount = selectedCheckpoint.expectedAssistantHashes.length;
        if (selectedCheckpoint.compactedInput.length >= assistantCount) {
          sources.push({
            kind: 'checkpoint',
            prefix: selectedCheckpoint.compactedInput.slice(
              0,
              selectedCheckpoint.compactedInput.length - assistantCount,
            ),
            tail: [
              ...selectedCheckpoint.compactedInput.slice(
                selectedCheckpoint.compactedInput.length - assistantCount,
              ),
              ...checkpointMatch.delta,
            ],
            prefixInputTokens: selectedCheckpoint.lastInputTokens,
          });
        }
      }
      return sources;
    };
    const recoverySources = overflowSources();
    const sourceEstimatedInputTokens = recoverySources.reduce<number | undefined>((largest, source) => {
      if (source.prefixInputTokens === undefined) return largest;
      const estimate = source.prefixInputTokens + approximateResponsesItemsTokens(source.tail);
      return largest === undefined ? estimate : Math.max(largest, estimate);
    }, undefined);
    const overflowSourceEntry = selected && connectionEntries(partitionKey).includes(selected)
      ? selected
      : undefined;
    const liveContinuationEstimatedTokens = (
      selected?.responseId
      && selectedMatch
      && selected.lastInputTokens !== undefined
    )
      ? selected.lastInputTokens + approximateResponsesItemsTokens([
        ...(selected.expectedAssistant ?? []),
        ...selectedMatch.delta,
      ])
      : undefined;
    const checkpointContinuationInput = selectedCheckpoint && checkpointMatch
      ? [...selectedCheckpoint.compactedInput, ...checkpointMatch.delta]
      : undefined;
    const checkpointContinuationEstimatedTokens = (
      selectedCheckpoint
      && checkpointMatch
      && selectedCheckpoint.lastInputTokens !== undefined
    )
      ? selectedCheckpoint.lastInputTokens + approximateResponsesItemsTokens([
        ...selectedCheckpoint.compactedInput.slice(
          Math.max(
            0,
            selectedCheckpoint.compactedInput.length
              - selectedCheckpoint.expectedAssistantHashes.length,
          ),
        ),
        ...checkpointMatch.delta,
      ])
      : undefined;
    const matchedCanonicalInput = selected?.compactedInput && selectedDelta
      ? [...selected.compactedInput, ...selectedDelta]
      : checkpointContinuationInput;
    const measuredMatchedCanonicalTokens = liveContinuationEstimatedTokens
      ?? checkpointContinuationEstimatedTokens;
    const matchedCanonicalEstimatedTokens = measuredMatchedCanonicalTokens
      ?? (matchedCanonicalInput
        ? estimatedRebasedInputTokens(
          matchedCanonicalInput,
          [],
          inputArray(payload),
          estimatedInputTokens,
        )
        : undefined);
    const matchedCanonicalFitsContext = (
      contextWindow !== undefined
      && matchedCanonicalEstimatedTokens !== undefined
      && matchedCanonicalEstimatedTokens < contextWindow
    );
    const overflowRecovery = compactThreshold !== undefined
      ? new ResponsesOverflowRecoverySession({
        requestUrl,
        headers,
        payload,
        compactThreshold,
        contextWindow: contextWindow ?? Number.MAX_SAFE_INTEGER,
        fetch: options.compactFetch,
        signal: init?.signal ?? undefined,
        compactTimeoutMs: options.compactTimeoutMs,
        maxCompactCalls: options.overflowRecoveryMaxCompactCalls,
        maxContextRejections: options.overflowRecoveryMaxContextRejections,
        deadlineMs: options.overflowRecoveryDeadlineMs,
        finalCreateReserveMs: options.overflowRecoveryFinalCreateReserveMs,
        now: resolvedOptions.now,
        onDiagnostic: event => {
          // SAFETY: Overflow recovery emits the same structured diagnostic contract.
          emitDiagnostic(options, event as ResponsesWebSocketDiagnosticEvent, diagnosticCorrelation);
        },
      })
      : undefined;
    const commitOverflowRebase = (rebasedInput: JsonValue[], rebasedEstimate: number): void => {
      sendPayload = { ...payload, input: rebasedInput };
      delete sendPayload.previous_response_id;
      retryPayload = sendPayload;
      compactedInputBase = rebasedInput;
      overflowRebasedEstimate = rebasedEstimate;
      supersededEntry ??= overflowSourceEntry;
      selected = undefined;
      continued = false;
      compacted = true;
      decision = 'overflow_rebase_new_head';
    };
    const runOverflowRecovery = async (
      reason: OverflowRecoveryReason,
      forceInitialCompaction = reason !== 'known_oversized',
    ): Promise<boolean> => {
      if (!overflowRecovery || contextWindow === undefined || contextWindow <= 0) return false;
      const recoverFromMatchedCanonical = reason !== 'known_oversized' || anchored
        ? matchedCanonicalInput
        : undefined;
      const recoveryInput = compactedInputBase
        ?? recoverFromMatchedCanonical
        ?? inputArray(payload);
      const recoveryEstimate = compactedInputBase
        ? overflowRebasedEstimate ?? estimatedRebasedInputTokens(
          recoveryInput,
          [],
          inputArray(payload),
          estimatedInputTokens,
        )
        : recoverFromMatchedCanonical && matchedCanonicalEstimatedTokens !== undefined
          ? matchedCanonicalEstimatedTokens
        : sourceEstimatedInputTokens === undefined
          ? estimatedInputTokens
          : Math.max(estimatedInputTokens ?? 0, sourceEstimatedInputTokens);
      const result = await overflowRecovery.recover({
        input: recoveryInput,
        sources: compactedInputBase ? [] : recoverySources,
        estimatedInputTokens: recoveryEstimate,
        reason,
        forceInitialCompaction,
      });
      compactionUsage = overflowRecovery.usage;
      if (result.recovered && result.estimatedInputTokens !== undefined) {
        const admission = overflowRecovery.admitFinalCreate();
        if (!admission.ok) {
          emitDiagnostic(options, {
            event: 'ws_overflow_recovery',
            outcome: 'budget_exhausted',
            reason: admission.reason,
            remainingMs: admission.remainingMs,
            attemptCount: overflowRecovery.attemptCount,
          }, diagnosticCorrelation);
          return false;
        }
        commitOverflowRebase(result.input, result.estimatedInputTokens);
      }
      return result.recovered;
    };
    const recoverRejectedCompaction = async (): Promise<void> => {
      try {
        if (!await runOverflowRecovery('compact_context_rejection')) {
          terminalOverflowReason =
            'OpenAI rejected the oversized compact window and no dependency-safe prefix recovery succeeded';
        }
      } catch (error) {
        if (!(error instanceof ResponsesCompactionError)) throw error;
        terminalRecoveryFailure = error;
      }
    };
    if (
      compactThreshold !== undefined
      && anchored
      && matchedCanonicalInput
      && matchedCanonicalEstimatedTokens !== undefined
      && effectiveCompactThreshold !== undefined
      && matchedCanonicalEstimatedTokens >= effectiveCompactThreshold
    ) {
      try {
        const recovered = await runOverflowRecovery('known_oversized', true);
        if (
          !recovered
          && contextWindow !== undefined
          && matchedCanonicalEstimatedTokens >= contextWindow
        ) {
          terminalOverflowReason =
            'No dependency-safe native compaction prefix could recover the oversized anchored continuation';
        }
      } catch (error) {
        if (!(error instanceof ResponsesCompactionError)) throw error;
        terminalRecoveryFailure = error;
      }
    }
    if (
      compactThreshold !== undefined
      && contextWindow !== undefined
      && estimatedInputTokens !== undefined
      && estimatedInputTokens >= contextWindow
      && !matchedCanonicalFitsContext
      && !hasCompacted()
      && !terminalOverflowReason
      && !terminalRecoveryFailure
    ) {
      try {
        if (!await runOverflowRecovery('known_oversized')) {
          terminalOverflowReason = 'No dependency-safe native compaction prefix could recover the oversized request';
        }
      } catch (error) {
        if (!(error instanceof ResponsesCompactionError)) throw error;
        terminalRecoveryFailure = error;
      }
    }
    if (
      compactThreshold !== undefined
      && compactionReason
      && inputArray(payload).length > 0
      && !hasCompacted()
      && !terminalOverflowReason
    ) {
      if (selected && selectedDelta) {
        const triggerEntry = selected;
        let triggerStartedAt: number | undefined;
        failedTriggerCompactedInput = triggerEntry.compactedInput
          ? [...triggerEntry.compactedInput, ...selectedDelta]
          : undefined;
        try {
          const triggerClaim = overflowRecovery!.claimCompactionCall();
          if (!triggerClaim.ok) {
            throw new ResponsesCompactionError(
              `Overflow recovery budget exhausted: ${triggerClaim.reason}`,
            );
          }
          triggerStartedAt = resolvedOptions.now();
          emitDiagnostic(options, {
            event: 'ws_compaction',
            outcome: 'started',
            transport: 'previous_response_compaction_trigger',
            reason: compactionReason,
            threshold: effectiveCompactThreshold,
            configuredThreshold: compactThreshold,
            postCompactionInputTokens: provisionalPostCompactionInputTokens,
            measuredInputTokens,
            estimatedInputTokens,
            canonicalEstimatedInputTokens: matchedCanonicalEstimatedTokens,
            sourceItems: inputArray(payload).length,
            incrementalItems: selectedDelta.length,
            compactCallAttempt: triggerClaim.attempt,
          }, diagnosticCorrelation);
          const result = await runCompactionTrigger({
            entry: triggerEntry,
            delta: selectedDelta,
            compactTimeoutMs: triggerClaim.timeoutMs,
            payload,
            promptFieldHashes,
            instructionsSnapshot,
            partitionKey,
            diagnostic: options.onDiagnostic
              ? event => emitDiagnostic(options, event, diagnosticCorrelation)
              : undefined,
            createReplacement: () => createConnection(
              WebSocket,
              wsUrl,
              headers,
              Boolean(partitionKey),
              partitionKey,
              checkpointKey,
              checkpointStoreDir,
              resolvedOptions,
              debug,
              proxyUrl,
            ),
            signal: init?.signal,
          });
          overflowRecovery!.recordExternalCompaction(undefined, result.usage);
          const compactedInput = [
            ...retainedUserMessages(inputArray(payload)),
            ...result.output,
          ];
          sendPayload = { ...payload, input: compactedInput };
          delete sendPayload.previous_response_id;
          retryPayload = sendPayload;
          compactedInputBase = compactedInput;
          supersededEntry = undefined;
          selected = undefined;
          continued = false;
          compacted = true;
          compactionUsage = overflowRecovery!.usage;
          decision = 'compaction_trigger_new_head';
          debug(
            `native compaction trigger produced ${result.output.length} item(s); `
            + `retained ${compactedInput.length - result.output.length} user item(s) `
            + `reason=${compactionReason}`,
          );
          emitDiagnostic(options, {
            event: 'ws_compaction',
            outcome: 'completed',
            transport: 'previous_response_compaction_trigger',
            reason: compactionReason,
            durationMs: Math.max(0, resolvedOptions.now() - triggerStartedAt),
            threshold: effectiveCompactThreshold,
            configuredThreshold: compactThreshold,
            postCompactionInputTokens: provisionalPostCompactionInputTokens,
            measuredInputTokens,
            estimatedInputTokens,
            liveContinuationEstimatedTokens,
            sourceItems: inputArray(payload).length,
            retainedItems: compactedInput.length - result.output.length,
            compactedItems: result.output.length,
            triggerWireBytes: result.triggerWireBytes,
            ...result.usage,
          }, diagnosticCorrelation);
        } catch (error) {
          const triggerError = error instanceof ResponsesCompactionError ? error : undefined;
          // A rejected in-band trigger is a response-create rejection, not a
          // standalone compact-endpoint rejection. It consumes the global call
          // budget but must not prevent the dependency-safe fallback itself.
          overflowRecovery?.recordExternalCompaction(error, triggerError?.usage, false);
          compactionUsage = overflowRecovery?.usage ?? triggerError?.usage;
          debug('native compaction trigger unavailable; trying standalone compact endpoint');
          emitDiagnostic(options, {
            event: 'ws_compaction',
            outcome: 'fallback',
            transport: 'previous_response_compaction_trigger',
            reason: compactionReason,
            durationMs: triggerStartedAt === undefined
              ? undefined
              : Math.max(0, resolvedOptions.now() - triggerStartedAt),
            threshold: effectiveCompactThreshold,
            configuredThreshold: compactThreshold,
            postCompactionInputTokens: provisionalPostCompactionInputTokens,
            measuredInputTokens,
            estimatedInputTokens,
            errorType: boundedDiagnosticIdentifier(runtimeTypeName(error)),
            statusCode: isObject(error) && 'statusCode' in error
              && isNumber(error.statusCode)
              ? error.statusCode
              : undefined,
          }, diagnosticCorrelation);
          if (!connectionEntries(partitionKey).includes(triggerEntry)) selected = undefined;
        }
      }

      if (!compacted && standaloneCompactionNotFound) {
        debug('standalone compaction skipped after an earlier HTTP 404 on this transport');
        emitDiagnostic(options, {
          event: 'ws_compaction',
          outcome: 'skipped',
          transport: 'responses_compact_endpoint',
          mode: 'routine',
          reason: compactionReason,
          skipReason: 'endpoint_not_found_cached',
          statusCode: 404,
          threshold: effectiveCompactThreshold,
          configuredThreshold: compactThreshold,
          postCompactionInputTokens: provisionalPostCompactionInputTokens,
          contextWindow,
          measuredInputTokens,
          estimatedInputTokens,
        }, diagnosticCorrelation);
      } else if (!compacted) {
        let standaloneStartedAt: number | undefined;
        try {
          const checkpointInput = selectedCheckpoint && checkpointMatch
            ? [...selectedCheckpoint.compactedInput, ...checkpointMatch.delta]
            : undefined;
          const selectedCompactedInput = selected?.compactedInput && selectedDelta
            ? [...selected.compactedInput, ...selectedDelta]
            : undefined;
          const canonicalInput = checkpointInput
            ?? selectedCompactedInput
            ?? failedTriggerCompactedInput;
          const compactPayload = canonicalInput
            ? { ...payload, input: canonicalInput }
            : payload;
          const compactClaim = overflowRecovery!.claimCompactionCall();
          if (!compactClaim.ok) {
            throw new ResponsesCompactionError(
              `Overflow recovery budget exhausted: ${compactClaim.reason}`,
            );
          }
          standaloneStartedAt = resolvedOptions.now();
          emitDiagnostic(options, {
            event: 'ws_compaction',
            outcome: 'started',
            transport: 'responses_compact_endpoint',
            mode: 'routine',
            reason: compactionReason,
            threshold: effectiveCompactThreshold,
            configuredThreshold: compactThreshold,
            postCompactionInputTokens: provisionalPostCompactionInputTokens,
            contextWindow,
            measuredInputTokens,
            estimatedInputTokens,
            canonicalEstimatedInputTokens: matchedCanonicalEstimatedTokens,
            rawReplayItems: inputArray(payload).length,
            sourceItems: inputArray(compactPayload).length,
            source: canonicalInput ? 'canonical' : 'raw',
            compactCallAttempt: compactClaim.attempt,
          }, diagnosticCorrelation);
          const result = await compactResponsesWindow({
            requestUrl,
            headers,
            payload: compactPayload,
            fetch: options.compactFetch,
            signal: init?.signal ?? undefined,
            timeoutMs: compactClaim.timeoutMs,
          });
          overflowRecovery!.recordExternalCompaction(undefined, result.usage);
          sendPayload = { ...payload, input: result.output };
          delete sendPayload.previous_response_id;
          retryPayload = sendPayload;
          compactedInputBase = result.output;
          supersededEntry = selected && connectionEntries(partitionKey).includes(selected)
            ? selected
            : undefined;
          selected = undefined;
          continued = false;
          compacted = true;
          compactionUsage = overflowRecovery!.usage;
          decision = 'compaction_new_head';
          debug(
            `standalone compact reduced ${inputArray(compactPayload).length} input item(s) `
            + `to ${result.output.length} item(s) reason=${compactionReason}`,
          );
          const usage: ResponsesCompactionUsage | undefined = result.usage;
          emitDiagnostic(options, {
            event: 'ws_compaction',
            outcome: 'completed',
            transport: 'responses_compact_endpoint',
            reason: compactionReason,
            durationMs: Math.max(0, resolvedOptions.now() - standaloneStartedAt),
            threshold: effectiveCompactThreshold,
            configuredThreshold: compactThreshold,
            postCompactionInputTokens: provisionalPostCompactionInputTokens,
            measuredInputTokens,
            estimatedInputTokens,
            sourceItems: inputArray(compactPayload).length,
            compactedItems: result.output.length,
            ...usage,
          }, diagnosticCorrelation);
        } catch (error) {
          const compactError = error instanceof ResponsesCompactionError ? error : undefined;
          if (compactError?.statusCode === 404) standaloneCompactionNotFound = true;
          overflowRecovery?.recordExternalCompaction(error, compactError?.usage);
          compactionUsage = overflowRecovery?.usage ?? compactionUsage;
          const contextRejected = compactError?.failureClass === 'context_length';
          debug(contextRejected
            ? 'standalone compaction rejected oversized input; planning dependency-safe prefix recovery'
            : 'standalone compaction unavailable; preserving normal response path');
          emitDiagnostic(options, {
            event: 'ws_compaction',
            outcome: contextRejected ? 'overflow_recovery' : 'fallback',
            transport: 'responses_compact_endpoint',
            reason: compactionReason,
            durationMs: standaloneStartedAt === undefined
              ? undefined
              : Math.max(0, resolvedOptions.now() - standaloneStartedAt),
            threshold: effectiveCompactThreshold,
            configuredThreshold: compactThreshold,
            postCompactionInputTokens: provisionalPostCompactionInputTokens,
            contextWindow,
            measuredInputTokens,
            estimatedInputTokens,
            errorType: boundedDiagnosticIdentifier(runtimeTypeName(error)),
            statusCode: compactError?.statusCode,
            failureClass: compactError?.failureClass,
            errorCode: boundedDiagnosticIdentifier(compactError?.errorCode),
            providerErrorType: boundedDiagnosticIdentifier(compactError?.errorType),
            errorFingerprint: compactError?.errorFingerprint,
          }, diagnosticCorrelation);
          if (contextRejected) await recoverRejectedCompaction();
        }
      }
    }

    if (terminalRecoveryFailure) {
      const status = terminalRecoveryFailure.statusCode
        ?? (terminalRecoveryFailure.failureClass === 'timeout_or_transport' ? 504 : 502);
      emitDiagnostic(options, {
        event: 'ws_overflow_recovery',
        outcome: 'failed',
        reason: 'non_context_compaction_failure',
        statusCode: status,
        failureClass: terminalRecoveryFailure.failureClass,
        errorCode: terminalRecoveryFailure.errorCode,
        providerErrorType: terminalRecoveryFailure.errorType,
        errorFingerprint: terminalRecoveryFailure.errorFingerprint,
      }, diagnosticCorrelation);
      return new Response(JSON.stringify({
        error: {
          type: terminalRecoveryFailure.errorType ?? 'compaction_error',
          code: terminalRecoveryFailure.errorCode ?? terminalRecoveryFailure.failureClass,
          message: terminalRecoveryFailure.message,
        },
      }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (terminalOverflowReason) {
      emitDiagnostic(options, {
        event: 'ws_overflow_recovery',
        outcome: 'exhausted',
        reason: terminalOverflowReason,
        contextWindow,
        compactThreshold,
        estimatedInputTokens,
        attemptCount: overflowRecovery?.attemptCount ?? 0,
      }, diagnosticCorrelation);
      return new Response(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          message: terminalOverflowReason,
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const nurseryConnectionCount = connectionCountByGeneration('nursery');
    const dispatchPlan = finalizeResponsesSession({
      payload,
      partitionKey,
      now,
      maxNurseryConnections: resolvedOptions.maxNurseryConnections,
      nurseryConnectionCount,
      hasIdleNursery: connectionEntries()
        .some(entry => !entry.inFlight && entry.generation === 'nursery'),
      forceCompaction: forceCompaction && Boolean(checkpointKey),
      compacted,
      sendPayload,
      compactedInputBase,
      retryPayload,
      initialDecision: decision,
      initialPersistent: persistent,
      headPlan: {
        ...headPlan,
        selected,
        selectedMatch,
        selectedDelta,
        selectedCheckpoint,
        checkpointMatch,
      },
      findReusableHead: () => reusableCacheAffinityHead(
        partitionKey,
        diagnosticCorrelation?.claudeAgentId,
        promptFieldHashes,
      ),
    });
    ({
      selected,
      selectedCheckpoint,
      selectedMatch,
      checkpointMatch,
      sendPayload,
      retryPayload,
      compactedInputBase,
      continued,
      persistent,
      decision,
    } = dispatchPlan);
    selectedDelta = selectedMatch?.delta;
    if (dispatchPlan.promoteSelected && selected) {
      evictions.push(...evictOldestIdleGeneration(
        'established',
        resolvedOptions.maxConnections,
        'established_lru_cap',
      ));
      selected.generation = 'established';
    }
    if (dispatchPlan.debugMessage) debug(dispatchPlan.debugMessage);

    if (dispatchPlan.evictNurseryBeforeCreate) {
      evictions.push(...evictOldestIdleGeneration(
        'nursery',
        resolvedOptions.maxNurseryConnections,
        'nursery_lru_cap',
      ));
    }

    const requestInput = preparedConversation.items;
    emitDiagnostic(options, responsesSessionDecisionMetadata({
      wsUrl,
      options,
      payload,
      partitionKey,
      checkpointCount: checkpoints.length,
      promptFingerprint,
      promptFieldHashes,
      promptChanges,
      now,
      compactThreshold,
      effectiveCompactThreshold,
      provisionalPostCompactionInputTokens,
      persistedNextCompactionInputTokens,
      contextWindow,
      activeConnectionCount: connectionCount(),
      nurseryConnectionCount: connectionCountByGeneration('nursery'),
      establishedConnectionCount: connectionCountByGeneration('established'),
      maxConnections: resolvedOptions.maxConnections,
      maxNurseryConnections: resolvedOptions.maxNurseryConnections,
      nextConnectionDebugId: peekNextConnectionDebugId(),
      evictions,
      headPlan,
      dispatchPlan: {
        ...dispatchPlan,
        selected,
        selectedCheckpoint,
        selectedMatch,
        checkpointMatch,
      },
    }), diagnosticCorrelation);

    if (
      decision === 'claude_compaction_checkpoint'
      && compactedInputBase
      && checkpointKey
    ) {
      const checkpointId = randomUUID();
      const responseId = `clodex_compact_${checkpointId}`;
      const itemId = `msg_${checkpointId}`;
      const summaryText = syntheticClaudeCompactionSummary(checkpointId);
      const assistantItem = syntheticAssistantMessage(itemId, summaryText);
      const summaryHash = compactionSummaryHash(summaryText);
      if (!summaryHash) {
        throw new ResponsesCompactionError('Synthetic Claude compaction marker was not anchorable');
      }
      const checkpoint: HydratedCompactionCheckpoint = {
        connectionId: 0,
        lineageId: allocateLineageDebugId(),
        lineageKey: randomUUID(),
        key: checkpointKey,
        requestInput,
        expectedAssistant: [assistantItem],
        requestInputHashes: requestInput.map(conversationItemHash),
        requestInputKinds: requestInput.map(conversationItemKind),
        expectedAssistantHashes: [conversationItemHash(assistantItem)],
        expectedAssistantKinds: [conversationItemKind(assistantItem)],
        compactedInput: [...compactedInputBase, assistantItem],
        lastInputTokens: compactionUsage?.outputTokens,
        claudeCompactionSummaryHash: summaryHash,
        promptFieldHashes,
        instructionsSnapshot,
        lastUsedAt: now,
        ttlMs: checkpointStoreDir
          ? RESPONSES_COMPACTION_DURABLE_CHECKPOINT_TTL_MS
          : RESPONSES_COMPACTION_CHECKPOINT_TTL_MS,
        checkpointStoreDir,
      };
      const checkpointDurable = persistCompactionCheckpoint(checkpoint, debug);
      if (supersededEntry) deleteEntry(supersededEntry);
      emitDiagnostic(options, {
        event: 'ws_compaction',
        outcome: 'synthetic_checkpoint',
        transport: 'claude_compaction_response',
        reason: compactionReason,
        checkpointItems: checkpoint.compactedInput.length,
        checkpointDurable,
        ...compactionUsage,
      }, diagnosticCorrelation);
      return syntheticClaudeCompactionResponse(
        responseId,
        assistantItem,
        summaryText,
        compactionUsage,
      );
    }

    const recoverContextOverflow = createOverflowRecoveryHandler({
      contextWindow,
      recover: () => runOverflowRecovery('response_context_rejection'),
      retryState: () => ({
        retryPayload,
        compactedInputBase,
        attemptCount: overflowRecovery?.attemptCount ?? 0,
      }),
    });

    let activeContext: RequestContext | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const ctx: RequestContext = {
          controller,
          encoder: new TextEncoder(),
          originalPayload: payload,
          sendPayload,
          retryPayload,
          compactedInputBase,
          establishCompactionRearm: compacted
            || Boolean(compactedInputBase && persistedNextCompactionInputTokens === undefined),
          compactThreshold,
          contextWindow,
          postCompactionInputTokens: compacted
            ? undefined
            : persistedPostCompactionInputTokens,
          nextCompactionInputTokens: compacted
            ? undefined
            : persistedNextCompactionInputTokens,
          supersededEntry,
          claudeCompactionRequest: forceCompaction,
          claudeCompactionSummaryHash: selectedMatch?.mode === 'claude_compaction_summary'
            ? selected?.claudeCompactionSummaryHash
            : checkpointMatch?.mode === 'claude_compaction_summary'
              ? selectedCheckpoint?.claudeCompactionSummaryHash
              : undefined,
          claudeAgentId: diagnosticCorrelation?.claudeAgentId,
          promptFieldHashes,
          instructionsSnapshot,
          continued,
          retried: false,
          closed: false,
          frameCount: 0,
          pendingEvents: [],
          emittedModelData: false,
          transportRetryPending: false,
          overflowRecoveryPending: false,
          overflowRetried: false,
          recoverContextOverflow: compactThreshold !== undefined && contextWindow !== undefined
            ? recoverContextOverflow
            : undefined,
          outputByIndex: new Map(),
          outputIndexByItemId: new Map(),
          emitDiagnostic: options.onDiagnostic
            ? event => emitDiagnostic(options, event, diagnosticCorrelation)
            : undefined,
          createReplacement: () => createConnection(
            WebSocket,
            wsUrl,
            headers,
            persistent,
            partitionKey,
            checkpointKey,
            checkpointStoreDir,
            resolvedOptions,
            debug,
            proxyUrl,
          ),
        };
        activeContext = ctx;

        const entry = selected ?? createConnection(
          WebSocket,
          wsUrl,
          headers,
          persistent,
          partitionKey,
          checkpointKey,
          checkpointStoreDir,
          resolvedOptions,
          debug,
          proxyUrl,
        );
        if (decision === 'history_mismatch_reused_head') beginRecycledLineage(entry);
        if (decision === 'compaction_checkpoint' && selectedCheckpoint) {
          entry.lineageId = selectedCheckpoint.lineageId;
          entry.lineageKey = selectedCheckpoint.lineageKey;
        }
        dispatchContext(entry, ctx);

        const signal = init?.signal;
        if (signal) {
          const abort = () => {
            if (ctx.closed) return;
            if (ctx.entry) deleteEntry(ctx.entry);
            closeContext(ctx);
          };
          if (signal.aborted) abort();
          else {
            signal.addEventListener('abort', abort, { once: true });
            ctx.abortCleanup = () => signal.removeEventListener('abort', abort);
          }
        }
      },
      cancel() {
        // The SDK cancelling the synthetic response invalidates any in-flight
        // connection-local state; the AbortSignal path normally runs first.
        const ctx = activeContext;
        if (!ctx || ctx.closed) return;
        if (ctx.entry) deleteEntry(ctx.entry);
        closeContext(ctx);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }) as FetchFunction;
}
