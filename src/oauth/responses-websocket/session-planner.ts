import { createHash } from 'node:crypto';
import { isObject, isString } from '../../runtime/type-guards.js';
import {
  changedPromptFields,
  inputArray,
} from './fingerprint.js';
import {
  claudeCompactionEnvelopeOccurrenceCount,
  continuationMatch,
  continuationMatchRank,
  continuationMismatchDetails,
  continuationMismatchSummary,
  conversationItemKind,
  historyContinuationMatch,
  queuedEventExtensionMatch,
  prepareConversationItems,
  type ContinuationMatch,
  type PreparedConversationItems,
} from './continuation.js';
import type {
  CompactionCheckpoint,
  ConnectionEntry,
  JsonObject,
  JsonValue,
  ResponsesWebSocketDiagnosticEvent,
  ResponsesWebSocketFetchOptions,
} from './types.js';

export type ResponsesSessionDecision =
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
  | 'unpartitioned_socket';

interface MatchingHead {
  entry: ConnectionEntry;
  match: ContinuationMatch;
}

interface MatchingCheckpoint {
  checkpoint: CompactionCheckpoint;
  match: ContinuationMatch;
}

export interface ResponsesSessionHeadPlan {
  candidates: ConnectionEntry[];
  idleCandidates: ConnectionEntry[];
  matches: MatchingHead[];
  checkpointMatches: MatchingCheckpoint[];
  preparedConversation: PreparedConversationItems;
  selected?: ConnectionEntry;
  selectedMatch?: ContinuationMatch;
  selectedDelta?: JsonValue[];
  selectedCheckpoint?: CompactionCheckpoint;
  checkpointMatch?: ContinuationMatch;
  diagnosticEntry?: ConnectionEntry;
  compactionEnvelopeCount: number;
  anchored: boolean;
  missedCompactionAnchor: boolean;
}

export interface PlanResponsesSessionHeadOptions {
  payload: JsonObject;
  candidates: ConnectionEntry[];
  checkpoints: CompactionCheckpoint[];
  forceCompaction: boolean;
  claudeAgentId?: string;
}

/**
 * Match the SDK-serialized request to a live response chain or durable compact
 * checkpoint. Transport code consumes this plan but does not interpret Claude
 * history itself.
 */
export function planResponsesSessionHead({
  payload,
  candidates,
  checkpoints,
  forceCompaction,
  claudeAgentId,
}: PlanResponsesSessionHeadOptions): ResponsesSessionHeadPlan {
  const idleCandidates = candidates.filter(entry => !entry.inFlight);
  const preparedConversation = prepareConversationItems(payload);
  const matches = idleCandidates
    .map(entry => ({
      entry,
      match: continuationMatch(entry, payload, preparedConversation)
        ?? (entry.claudeAgentId === claudeAgentId
          ? queuedEventExtensionMatch(entry, payload, preparedConversation)
          : undefined),
    }))
    .filter((candidate): candidate is MatchingHead => candidate.match !== undefined)
    .toSorted((left, right) => left.match.delta.length - right.match.delta.length
      || continuationMatchRank(left.match.mode) - continuationMatchRank(right.match.mode));
  let selected = matches[0]?.entry;
  let selectedMatch = matches[0]?.match;
  let selectedDelta = selectedMatch?.delta;

  if (!selected && forceCompaction) {
    const compactInstruction = inputArray(payload).at(-1);
    const agentCandidates = idleCandidates.filter(
      entry => entry.claudeAgentId === claudeAgentId,
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

  const checkpointMatches = checkpoints
    .map(checkpoint => ({
      checkpoint,
      match: historyContinuationMatch(checkpoint, payload, preparedConversation),
    }))
    .filter((candidate): candidate is MatchingCheckpoint => candidate.match !== undefined)
    .toSorted((left, right) => left.match.delta.length - right.match.delta.length
      || continuationMatchRank(left.match.mode) - continuationMatchRank(right.match.mode)
      || (left.checkpoint.lastInputTokens ?? Number.MAX_SAFE_INTEGER)
        - (right.checkpoint.lastInputTokens ?? Number.MAX_SAFE_INTEGER));
  const checkpointCandidate = selected ? undefined : checkpointMatches[0];
  const selectedCheckpoint = checkpointCandidate?.checkpoint;
  const checkpointMatch = selectedCheckpoint ? checkpointCandidate.match : undefined;
  const compactionEnvelopeCount = claudeCompactionEnvelopeOccurrenceCount(payload);
  const anchored = selectedMatch?.mode === 'claude_compaction_summary'
    || checkpointMatch?.mode === 'claude_compaction_summary';
  const missedCompactionAnchor = compactionEnvelopeCount > 0
    && !anchored
    && (
      candidates.some(entry => entry.claudeCompactionSummaryHash)
      || checkpoints.some(checkpoint => checkpoint.claudeCompactionSummaryHash)
    );
  const diagnosticEntry = selected
    ?? [...idleCandidates].toSorted((left, right) => right.lastUsedAt - left.lastUsedAt)[0]
    ?? candidates[0];

  return {
    candidates,
    idleCandidates,
    matches,
    checkpointMatches,
    preparedConversation,
    selected,
    selectedMatch,
    selectedDelta,
    selectedCheckpoint,
    checkpointMatch,
    diagnosticEntry,
    compactionEnvelopeCount,
    anchored,
    missedCompactionAnchor,
  };
}

export interface FinalizeResponsesSessionOptions {
  payload: JsonObject;
  partitionKey?: string;
  now: number;
  maxNurseryConnections: number;
  nurseryConnectionCount: number;
  hasIdleNursery: boolean;
  forceCompaction: boolean;
  compacted: boolean;
  sendPayload: JsonObject;
  compactedInputBase?: JsonValue[];
  retryPayload?: JsonObject;
  initialDecision: ResponsesSessionDecision;
  initialPersistent: boolean;
  headPlan: ResponsesSessionHeadPlan;
  findReusableHead: () => ConnectionEntry | undefined;
}

export interface ResponsesSessionDispatchPlan {
  selected?: ConnectionEntry;
  selectedCheckpoint?: CompactionCheckpoint;
  selectedMatch?: ContinuationMatch;
  checkpointMatch?: ContinuationMatch;
  sendPayload: JsonObject;
  retryPayload?: JsonObject;
  compactedInputBase?: JsonValue[];
  continued: boolean;
  persistent: boolean;
  decision: ResponsesSessionDecision;
  promotedConnectionId?: number;
  promoteSelected: boolean;
  evictNurseryBeforeCreate: boolean;
  debugMessage?: string;
}

/**
 * Finalize the logical response-chain request after optional compaction. The
 * caller applies the returned pool mutations, then performs thin dispatch.
 */
export function finalizeResponsesSession({
  payload,
  partitionKey,
  now,
  maxNurseryConnections,
  nurseryConnectionCount,
  hasIdleNursery,
  forceCompaction,
  compacted,
  sendPayload: initialSendPayload,
  compactedInputBase: initialCompactedInputBase,
  retryPayload: initialRetryPayload,
  initialDecision,
  initialPersistent,
  headPlan,
  findReusableHead,
}: FinalizeResponsesSessionOptions): ResponsesSessionDispatchPlan {
  let { selected, selectedCheckpoint, selectedMatch, checkpointMatch } = headPlan;
  const selectedDelta = selectedMatch?.delta;
  let sendPayload = initialSendPayload;
  let retryPayload = initialRetryPayload;
  let compactedInputBase = initialCompactedInputBase;
  let continued = false;
  let persistent = initialPersistent;
  let decision = initialDecision;
  let promotedConnectionId: number | undefined;
  let promoteSelected = false;
  let debugMessage: string | undefined;

  if (compacted) {
    if (forceCompaction && compactedInputBase) decision = 'claude_compaction_checkpoint';
  } else if (selected && selectedDelta) {
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
      promotedConnectionId = selected.debugId;
      promoteSelected = true;
    }
    decision = 'continuation';
    debugMessage = `continuing chain with ${selectedDelta.length} incremental input item(s)`
      + (selectedMatch.mode === 'queued_after_active'
        ? ' after serializing queued input behind the active sample'
        : selectedMatch.mode === 'replayed_reasoning'
        ? ' after accepting replayed opaque reasoning'
        : selectedMatch.mode === 'omitted_reasoning'
          ? ' after accepting omitted reasoning'
          : selectedMatch.mode === 'omitted_queued_event'
            ? ' after retaining an omitted queued event'
            : selectedMatch.mode === 'claude_compaction_summary'
              ? ' after re-anchoring Claude compacted history'
              : '');
  } else if (selectedCheckpoint && checkpointMatch) {
    const compactedInput = [...selectedCheckpoint.compactedInput, ...checkpointMatch.delta];
    sendPayload = { ...payload, input: compactedInput };
    delete sendPayload.previous_response_id;
    retryPayload = sendPayload;
    compactedInputBase = compactedInput;
    decision = 'compaction_checkpoint';
    selectedCheckpoint.lastUsedAt = now;
    debugMessage = `restored compact checkpoint with ${checkpointMatch.delta.length} incremental input item(s)`;
  } else if (headPlan.candidates.some(entry => entry.inFlight)) {
    const reusable = findReusableHead();
    if (reusable) {
      selected = reusable;
      decision = 'history_mismatch_reused_head';
      debugMessage = `parallel history mismatch reusing idle nursery connection=${reusable.debugId}`;
    } else {
      selected = undefined;
      const nurseryAtCapacity = nurseryConnectionCount >= maxNurseryConnections;
      persistent = !nurseryAtCapacity || hasIdleNursery;
      decision = persistent ? 'parallel_new_head' : 'parallel_isolated';
      debugMessage = persistent
        ? 'parallel request starting a retained nursery head'
        : 'parallel request using an isolated socket at nursery capacity';
    }
  } else if (headPlan.diagnosticEntry) {
    const reusable = findReusableHead();
    if (reusable) {
      selected = reusable;
      decision = 'history_mismatch_reused_head';
      debugMessage = `history mismatch reusing idle nursery connection=${reusable.debugId}; `
        + `retained ${headPlan.candidates.length - 1} other head(s) `
        + `(${continuationMismatchSummary(headPlan.diagnosticEntry, payload)})`;
    } else {
      debugMessage = `history mismatch starting an additional chain; retained `
        + `${headPlan.candidates.length} existing head(s) `
        + `(${continuationMismatchSummary(headPlan.diagnosticEntry, payload)})`;
      decision = 'history_mismatch_new_head';
    }
  } else if (partitionKey) {
    decision = 'new_partition_head';
  } else {
    decision = 'unpartitioned_socket';
  }

  return {
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
    promotedConnectionId,
    promoteSelected,
    evictNurseryBeforeCreate: !selected && persistent,
    debugMessage,
  };
}

export interface ResponsesSessionDecisionMetadataOptions {
  wsUrl: string;
  options: ResponsesWebSocketFetchOptions;
  payload: JsonObject;
  partitionKey?: string;
  checkpointCount: number;
  promptFingerprint: string;
  promptFieldHashes: Record<string, string>;
  promptChanges: string[];
  now: number;
  compactThreshold?: number;
  effectiveCompactThreshold?: number;
  provisionalPostCompactionInputTokens?: number;
  persistedNextCompactionInputTokens?: number;
  contextWindow?: number;
  activeConnectionCount: number;
  nurseryConnectionCount: number;
  establishedConnectionCount: number;
  maxConnections: number;
  maxNurseryConnections: number;
  nextConnectionDebugId: number;
  evictions: JsonValue[];
  headPlan: ResponsesSessionHeadPlan;
  dispatchPlan: ResponsesSessionDispatchPlan;
}

/** Build privacy-safe diagnostics from the same plan used for dispatch. */
export function responsesSessionDecisionMetadata({
  wsUrl,
  options,
  payload,
  partitionKey,
  checkpointCount,
  promptFingerprint,
  promptFieldHashes,
  promptChanges,
  now,
  compactThreshold,
  effectiveCompactThreshold,
  provisionalPostCompactionInputTokens,
  persistedNextCompactionInputTokens,
  contextWindow,
  activeConnectionCount,
  nurseryConnectionCount,
  establishedConnectionCount,
  maxConnections,
  maxNurseryConnections,
  nextConnectionDebugId,
  evictions,
  headPlan,
  dispatchPlan,
}: ResponsesSessionDecisionMetadataOptions): ResponsesWebSocketDiagnosticEvent {
  const { selected, selectedCheckpoint, selectedMatch, checkpointMatch } = dispatchPlan;
  const requestInput = headPlan.preparedConversation.items;
  return {
    event: 'ws_head_decision',
    decision: dispatchPlan.decision,
    partitionKey,
    keyTuple: {
      wsUrl,
      providerId: options.providerId ?? 'openai',
      accountIdHash: options.accountId
        ? createHash('sha256').update(options.accountId).digest('hex').slice(0, 16)
        : '',
      model: isString(payload.model) ? payload.model : undefined,
      effort: isObject(payload.reasoning) && 'effort' in payload.reasoning
        && isString(payload.reasoning.effort)
        ? payload.reasoning.effort.trim().toLowerCase()
        : '',
      promptCacheKey: isString(payload.prompt_cache_key) ? payload.prompt_cache_key : undefined,
    },
    promptFingerprint,
    promptFieldHashes,
    promptChanges,
    input: {
      count: requestInput.length,
      kinds: requestInput.map(conversationItemKind),
      hashes: headPlan.preparedConversation.hashes,
    },
    candidateCount: headPlan.candidates.length,
    idleCandidateCount: headPlan.idleCandidates.length,
    matchingCandidateCount: headPlan.matches.length,
    checkpointCount,
    matchingCheckpointCount: headPlan.checkpointMatches.length,
    selectedCheckpointConnectionId: dispatchPlan.decision === 'compaction_checkpoint'
      ? selectedCheckpoint?.connectionId
      : undefined,
    compactThreshold,
    effectiveCompactThreshold,
    postCompactionInputTokens: provisionalPostCompactionInputTokens,
    nextCompactionInputTokens: persistedNextCompactionInputTokens,
    contextWindow,
    activeConnectionCount,
    nurseryConnectionCount,
    establishedConnectionCount,
    maxConnections,
    maxNurseryConnections,
    selectedConnectionId: selected?.debugId,
    selectedGeneration: selected?.generation,
    continuationMatchMode: selectedMatch?.mode ?? checkpointMatch?.mode,
    promotedConnectionId: dispatchPlan.promotedConnectionId,
    createdConnectionId: selected ? undefined : nextConnectionDebugId,
    createdGeneration: selected ? undefined : dispatchPlan.persistent ? 'nursery' : 'isolated',
    incrementalInputItems: selectedMatch?.delta.length,
    heads: headPlan.candidates.map(entry => ({
      connectionId: entry.debugId,
      generation: entry.generation,
      inFlight: entry.inFlight,
      ageMs: Math.max(0, now - entry.createdAt - entry.ttlPausedMs),
      physicalAgeMs: Math.max(0, now - entry.createdAt),
      ttlPausedMs: entry.ttlPausedMs,
      idleMs: Math.max(0, now - entry.lastUsedAt),
      promptChanges: changedPromptFields(entry.promptFieldHashes, promptFieldHashes),
      mismatch: continuationMismatchDetails(entry, payload, headPlan.preparedConversation),
      claudeAgentIdHash: entry.claudeAgentId
        ? createHash('sha256').update(entry.claudeAgentId).digest('hex').slice(0, 12)
        : undefined,
      recyclableAgentHead: entry.recyclableAgentHead,
    })),
    evictions,
  };
}
