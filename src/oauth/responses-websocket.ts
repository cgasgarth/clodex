import { createHash, randomUUID } from 'node:crypto';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { outboundProxyUrlForTarget } from '../outbound-proxy.js';
import { loadBunNativeWebSocket } from '../bun-websocket.js';
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
  RequestContext,
  ConnectionEntry,
  CompactionCheckpoint,
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
  continuationMatchRank,
  conversationItemKind,
  retainedUserMessages,
  compactionSummaryHash,
  claudeCompactionEnvelopeOccurrenceCount,
  conversationItemHash,
  continuationMismatchDetails,
  continuationMismatchSummary,
  historyContinuationMatch,
  continuationMatch,
  prepareConversationItems,
} from './responses-websocket/continuation.js';
import type { ContinuationMatch } from './responses-websocket/continuation.js';
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
  const resolvedOptions = resolveWebSocketOptions(options);
  // Durable native state must never remain active after the user disables the
  // native compaction opt-in, even if a caller accidentally supplies a path.
  const checkpointStoreDir = checkpointStoreDirectory(options);

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
    const idleCandidates = candidates.filter(entry => !entry.inFlight);
    const preparedConversation = prepareConversationItems(payload);
    const matches = idleCandidates
      .map(entry => ({
        entry,
        match: continuationMatch(entry, payload, preparedConversation),
      }))
      .filter((candidate): candidate is { entry: ConnectionEntry; match: ContinuationMatch } => candidate.match !== undefined)
      // Prefer the longest matching history, which produces the smallest delta.
        .sort((left, right) => left.match.delta.length - right.match.delta.length
        || continuationMatchRank(left.match.mode) - continuationMatchRank(right.match.mode));
    let selected: ConnectionEntry | undefined = matches[0]?.entry;
    let selectedMatch = matches[0]?.match;
    let selectedDelta = selectedMatch?.delta;
    if (!selected && forceCompaction) {
      const compactInstruction = inputArray(payload).at(-1);
      const agentCandidates = idleCandidates.filter(
        entry => entry.claudeAgentId === diagnosticCorrelation.claudeAgentId,
      );
      if (
        agentCandidates.length === 1
        && compactInstruction
        && conversationItemKind(compactInstruction) === 'user'
      ) {
        selected = agentCandidates[0];
        selectedMatch = {
          delta: [compactInstruction],
          mode: 'claude_compaction_request',
        };
        selectedDelta = selectedMatch.delta;
      }
    }
    const checkpointMatches = checkpointKey
      ? checkpointEntries(checkpointKey)
        .map(checkpoint => ({
          checkpoint,
          match: historyContinuationMatch(checkpoint, payload, preparedConversation),
        }))
        .filter((candidate): candidate is {
          checkpoint: CompactionCheckpoint;
          match: ContinuationMatch;
        } => candidate.match !== undefined)
      .sort((left, right) => left.match.delta.length - right.match.delta.length
          || continuationMatchRank(left.match.mode) - continuationMatchRank(right.match.mode)
          || (left.checkpoint.lastInputTokens ?? Number.MAX_SAFE_INTEGER)
            - (right.checkpoint.lastInputTokens ?? Number.MAX_SAFE_INTEGER))
      : [];
    const checkpointCandidate = selected ? undefined : checkpointMatches[0];
    const selectedCheckpoint = checkpointCandidate
      ? hydrateCompactionCheckpoint(checkpointCandidate.checkpoint, now)
      : undefined;
    const checkpointMatch = selectedCheckpoint ? checkpointCandidate?.match : undefined;
    const compactionEnvelopeCount = claudeCompactionEnvelopeOccurrenceCount(payload);
    const anchored = selectedMatch?.mode === 'claude_compaction_summary'
      || checkpointMatch?.mode === 'claude_compaction_summary';
    const hasCompacted = () => compacted;
    if (
      compactionEnvelopeCount > 0
      && !anchored
      && (
        candidates.some(entry => entry.claudeCompactionSummaryHash)
        || (checkpointKey
          ? checkpointEntries(checkpointKey).some(checkpoint => checkpoint.claudeCompactionSummaryHash)
          : false)
      )
    ) {
      emitDiagnostic(options, {
        event: 'ws_compaction',
        outcome: 'anchor_missed',
        reason: 'claude_compaction_summary',
        envelopeCount: compactionEnvelopeCount,
      }, diagnosticCorrelation);
    }
    const diagnosticEntry = selected
      ?? [...idleCandidates].sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0]
      ?? candidates[0];
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
    let compactedInputBase: unknown[] | undefined;
    let supersededEntry: ConnectionEntry | undefined;
    let continued = false;
    let persistent = Boolean(partitionKey);
    let promotedConnectionId: number | undefined;
    let decision:
      | 'continuation'
      | 'compaction_new_head'
      | 'overflow_rebase_new_head'
      | 'compaction_trigger_new_head'
      | 'claude_compaction_checkpoint'
      | 'compaction_checkpoint'
      | 'parallel_new_head'
      | 'parallel_isolated'
      | 'history_mismatch_reused_head'
      | 'history_mismatch_new_head'
      | 'new_partition_head'
      | 'unpartitioned_socket' = partitionKey
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
    let failedTriggerCompactedInput: unknown[] | undefined;
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
        onDiagnostic: event => emitDiagnostic(options, event as ResponsesWebSocketDiagnosticEvent, diagnosticCorrelation),
      })
      : undefined;
    const commitOverflowRebase = (rebasedInput: unknown[], rebasedEstimate: number): void => {
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
            ...(result.usage ?? {}),
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
            errorType: boundedDiagnosticIdentifier(
              error instanceof Error ? error.name : typeof error,
            ),
            statusCode: error && typeof error === 'object' && 'statusCode' in error
              && typeof error.statusCode === 'number'
              ? error.statusCode
              : undefined,
          }, diagnosticCorrelation);
          if (!connectionEntries(partitionKey).includes(triggerEntry)) selected = undefined;
        }
      }

      if (!compacted) {
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
            ...(usage ?? {}),
          }, diagnosticCorrelation);
        } catch (error) {
          const compactError = error instanceof ResponsesCompactionError ? error : undefined;
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
            errorType: boundedDiagnosticIdentifier(
              error instanceof Error ? error.name : typeof error,
            ),
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

    if (compacted) {
      // Native compaction returned canonical input for a fresh response chain.
      if (forceCompaction && compactedInputBase && checkpointKey) {
        decision = 'claude_compaction_checkpoint';
      }
    } else if (selected && selectedDelta && selectedMatch) {
      sendPayload = { ...payload, input: selectedDelta, previous_response_id: selected.responseId };
      continued = true;
      compactedInputBase = selected.compactedInput
        ? [...selected.compactedInput, ...selectedDelta]
        : undefined;
      if (compactedInputBase) {
        retryPayload = { ...payload, input: compactedInputBase };
        delete retryPayload.previous_response_id;
      }
      if (selected.generation === 'nursery') {
        evictions.push(...evictOldestIdleGeneration(
          'established',
          resolvedOptions.maxConnections,
          'established_lru_cap',
        ));
        selected.generation = 'established';
        promotedConnectionId = selected.debugId;
      }
      decision = 'continuation';
      debug(
        `continuing chain with ${selectedDelta.length} incremental input item(s)`
        + (selectedMatch.mode === 'replayed_reasoning'
          ? ' after accepting replayed opaque reasoning'
          : selectedMatch.mode === 'omitted_reasoning'
            ? ' after accepting omitted reasoning'
          : selectedMatch.mode === 'claude_compaction_summary'
            ? ' after re-anchoring Claude compacted history'
            : ''),
      );
    } else if (selectedCheckpoint && checkpointMatch) {
      const compactedInput = [...selectedCheckpoint.compactedInput, ...checkpointMatch.delta];
      sendPayload = { ...payload, input: compactedInput };
      delete sendPayload.previous_response_id;
      retryPayload = sendPayload;
      compactedInputBase = compactedInput;
      decision = 'compaction_checkpoint';
      selectedCheckpoint.lastUsedAt = now;
      debug(
        `restored compact checkpoint with ${checkpointMatch.delta.length} incremental input item(s)`,
      );
    } else if (candidates.some(entry => entry.inFlight)) {
      // Claude workflow agents share the parent session id but carry divergent
      // histories. Reuse a warm idle nursery head when a later workflow wave
      // overlaps with an already-started sibling; otherwise give the branch a
      // retained new head. Fall back to isolation only when every nursery slot
      // is occupied by an active request.
      const reusable = reusableCacheAffinityHead(
        partitionKey,
        diagnosticCorrelation?.claudeAgentId,
        promptFieldHashes,
      );
      if (reusable) {
        selected = reusable;
        decision = 'history_mismatch_reused_head';
        debug(
          `parallel history mismatch reusing idle nursery connection=${reusable.debugId}`,
        );
      } else {
        selected = undefined;
        const nurseryAtCapacity = connectionCountByGeneration('nursery')
          >= resolvedOptions.maxNurseryConnections;
        const hasIdleNursery = connectionEntries()
          .some(entry => !entry.inFlight && entry.generation === 'nursery');
        persistent = !nurseryAtCapacity || hasIdleNursery;
        decision = persistent ? 'parallel_new_head' : 'parallel_isolated';
        debug(
          persistent
            ? 'parallel request starting a retained nursery head'
            : 'parallel request using an isolated socket at nursery capacity',
        );
      }
    } else if (diagnosticEntry) {
      // Reuse an idle nursery socket once a partition already has two warm
      // unproven heads, or a terminal head from a different Claude subagent
      // with an identical prompt shape. Full-history requests do not use
      // previous_response_id, but controlled probes show that keeping the
      // physical socket restores OpenAI prompt-cache affinity.
      const reusable = reusableCacheAffinityHead(
        partitionKey,
        diagnosticCorrelation?.claudeAgentId,
        promptFieldHashes,
      );
      if (reusable) {
        selected = reusable;
        decision = 'history_mismatch_reused_head';
        debug(
          `history mismatch reusing idle nursery connection=${reusable.debugId}; `
          + `retained ${candidates.length - 1} other head(s) `
          + `(${continuationMismatchSummary(diagnosticEntry, payload)})`,
        );
      } else {
        debug(
          `history mismatch starting an additional chain; retained ${candidates.length} existing head(s) `
          + `(${continuationMismatchSummary(diagnosticEntry, payload)})`,
        );
        decision = 'history_mismatch_new_head';
      }
    } else if (partitionKey) {
      decision = 'new_partition_head';
    } else {
      decision = 'unpartitioned_socket';
    }

    if (!selected && persistent) {
      evictions.push(...evictOldestIdleGeneration(
        'nursery',
        resolvedOptions.maxNurseryConnections,
        'nursery_lru_cap',
      ));
    }

    const requestInput = preparedConversation.items;
    emitDiagnostic(options, {
      event: 'ws_head_decision',
      decision,
      partitionKey,
      keyTuple: {
        wsUrl,
        providerId: options.providerId ?? 'openai',
        accountIdHash: options.accountId
          ? createHash('sha256').update(options.accountId).digest('hex').slice(0, 16)
          : '',
        model: typeof payload.model === 'string' ? payload.model : undefined,
        effort: typeof (payload.reasoning as JsonObject | undefined)?.effort === 'string'
          ? String((payload.reasoning as JsonObject).effort).trim().toLowerCase()
          : '',
        promptCacheKey: typeof payload.prompt_cache_key === 'string' ? payload.prompt_cache_key : undefined,
      },
      promptFingerprint,
      promptFieldHashes,
      promptChanges,
      input: {
        count: requestInput.length,
        kinds: requestInput.map(conversationItemKind),
        hashes: preparedConversation.hashes,
      },
      candidateCount: candidates.length,
      idleCandidateCount: idleCandidates.length,
      matchingCandidateCount: matches.length,
      checkpointCount: checkpointKey ? checkpointEntries(checkpointKey).length : 0,
      matchingCheckpointCount: checkpointMatches.length,
      selectedCheckpointConnectionId: decision === 'compaction_checkpoint'
        ? selectedCheckpoint?.connectionId
        : undefined,
      compactThreshold,
      effectiveCompactThreshold,
      postCompactionInputTokens: provisionalPostCompactionInputTokens,
      nextCompactionInputTokens: persistedNextCompactionInputTokens,
      contextWindow,
      activeConnectionCount: connectionCount(),
      nurseryConnectionCount: connectionCountByGeneration('nursery'),
      establishedConnectionCount: connectionCountByGeneration('established'),
      maxConnections: resolvedOptions.maxConnections,
      maxNurseryConnections: resolvedOptions.maxNurseryConnections,
      selectedConnectionId: selected?.debugId,
      selectedGeneration: selected?.generation,
      continuationMatchMode: selectedMatch?.mode ?? checkpointMatch?.mode,
      promotedConnectionId,
      createdConnectionId: selected ? undefined : peekNextConnectionDebugId(),
      createdGeneration: selected ? undefined : persistent ? 'nursery' : 'isolated',
      incrementalInputItems: selectedDelta?.length,
      heads: candidates.map(entry => ({
        connectionId: entry.debugId,
        generation: entry.generation,
        inFlight: entry.inFlight,
        ageMs: Math.max(0, now - entry.createdAt - entry.ttlPausedMs),
        physicalAgeMs: Math.max(0, now - entry.createdAt),
        ttlPausedMs: entry.ttlPausedMs,
        idleMs: Math.max(0, now - entry.lastUsedAt),
        promptChanges: changedPromptFields(entry.promptFieldHashes, promptFieldHashes),
        mismatch: continuationMismatchDetails(entry, payload, preparedConversation),
        claudeAgentIdHash: entry.claudeAgentId
          ? createHash('sha256').update(entry.claudeAgentId).digest('hex').slice(0, 12)
          : undefined,
        recyclableAgentHead: entry.recyclableAgentHead,
      })),
      evictions,
    }, diagnosticCorrelation);

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
        ...(compactionUsage ?? {}),
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
          reasoningPartsByItemId: new Map(),
          recentUpstreamEventTypes: [],
          emittedProtocolAnomalies: new Set(),
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
