import type { ResponsesCompactionUsage } from '../responses-compaction.js';
import {
  listStoredResponsesCheckpointFiles,
  loadStoredResponsesCheckpoint,
  saveStoredResponsesCheckpoint,
  type StoredResponsesCheckpointFile,
} from '../responses-checkpoint-store.js';
import {
  RESPONSES_COMPACTION_CHECKPOINT_TTL_MS,
  RESPONSES_COMPACTION_DURABLE_CHECKPOINT_TTL_MS,
  diagnosticContext,
} from './types.js';
import type {
  ResponsesWebSocketFetchOptions,
  JsonObject,
  ConnectionEntry,
  CompactionCheckpoint,
  HydratedCompactionCheckpoint,
} from './types.js';
import { conversationItemKind, conversationItemHash } from './continuation.js';
import { isString } from '../../runtime/type-guards.js';

// A Claude session partition can have multiple valid conversation heads at
// once: rewinds/branches, hidden title-generation requests, and stop hooks can
// all share its model/effort/cache key. Retain each head and select by exact
// conversation prefix instead of letting the newest branch replace the rest.
// New heads live in a separately capped nursery LRU until their first lineage
// continuation. Idle nursery sockets and terminal subagent heads are safe reuse
// pools for unrelated full-history requests: this preserves physical-socket
// prompt-cache affinity without overwriting active or same-agent lineages.
// One-shot nursery traffic never consumes the established LRU's 32 reserved slots.
const connections = new Map<string, Set<ConnectionEntry>>();
export const compactionCheckpoints = new Map<string, CompactionCheckpoint[]>();
const checkpointStoreNextScanAt = new Map<string, number>();
const CHECKPOINT_STORE_RESCAN_INTERVAL_MS = 5_000;
const MAX_COMPACTION_CHECKPOINTS_PER_PARTITION = 16;
const MAX_HYDRATED_DURABLE_CHECKPOINTS = 8;
// 64 global records is only four fully branched Claude sessions. Workflow-heavy
// use reaches that while sessions are still active, so a restart can lose the
// only canonical rebase. The seven-day TTL remains the primary retention bound.
const MAX_COMPACTION_CHECKPOINTS = 256;
let nextConnectionDebugId = 1;
let nextLineageDebugId = 1;

export function allocateConnectionDebugId(): number {
  return nextConnectionDebugId++;
}

export function peekNextConnectionDebugId(): number {
  return nextConnectionDebugId;
}

export function allocateLineageDebugId(): number {
  return nextLineageDebugId++;
}

export function connectionEntries(key?: string): ConnectionEntry[] {
  return key
    ? [...(connections.get(key) ?? [])]
    : [...connections.values()].flatMap(entries => Array.from(entries));
}

export function connectionCount(): number {
  let count = 0;
  for (const entries of connections.values()) count += entries.size;
  return count;
}

export function connectionCountByGeneration(generation: ConnectionEntry['generation']): number {
  return connectionEntries().filter(entry => entry.generation === generation).length;
}

export interface ResponsesWebSocketPoolSnapshot {
  total: number;
  open: number;
  inFlight: number;
  established: number;
  nursery: number;
  isolated: number;
  partitions: number;
  checkpoints: number;
}

/** Privacy-safe process-global pool counters for daemon diagnostics. */
export function responsesWebSocketPoolSnapshot(): ResponsesWebSocketPoolSnapshot {
  const entries = connectionEntries();
  return {
    total: entries.length,
    open: entries.filter(entry => entry.open).length,
    inFlight: entries.filter(entry => entry.inFlight).length,
    established: connectionCountByGeneration('established'),
    nursery: connectionCountByGeneration('nursery'),
    isolated: connectionCountByGeneration('isolated'),
    partitions: connections.size,
    checkpoints: checkpointEntries().length,
  };
}

export function checkpointEntries(key?: string): CompactionCheckpoint[] {
  return key
    ? [...(compactionCheckpoints.get(key) ?? [])]
    : [...compactionCheckpoints.values()].flat();
}

function upsertCompactionCheckpoint(
  checkpoint: CompactionCheckpoint,
  preferExistingOnTie = false,
): void {
  const existingPartition = compactionCheckpoints.get(checkpoint.key) ?? [];
  const existing = existingPartition.find(candidate => candidate.lineageKey === checkpoint.lineageKey);
  if (
    existing
    && (
      existing.lastUsedAt > checkpoint.lastUsedAt
      || (preferExistingOnTie && existing.lastUsedAt === checkpoint.lastUsedAt)
    )
  ) return;
  const partition = existingPartition.filter(
    candidate => candidate.lineageKey !== checkpoint.lineageKey,
  );
  partition.push(checkpoint);
  partition.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  compactionCheckpoints.set(
    checkpoint.key,
    partition.slice(0, MAX_COMPACTION_CHECKPOINTS_PER_PARTITION),
  );

  while (checkpointEntries().length > MAX_COMPACTION_CHECKPOINTS) {
    const oldest = checkpointEntries()
      .toSorted((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!oldest) break;
    const entries = (compactionCheckpoints.get(oldest.key) ?? [])
      .filter(candidate => candidate !== oldest);
    if (entries.length) compactionCheckpoints.set(oldest.key, entries);
    else compactionCheckpoints.delete(oldest.key);
  }
  const hydratedDurable = checkpointEntries()
    .filter(candidate => candidate.checkpointStoreDir && candidate.compactedInput)
    .toSorted((left, right) => right.lastUsedAt - left.lastUsedAt);
  for (const candidate of hydratedDurable.slice(MAX_HYDRATED_DURABLE_CHECKPOINTS)) {
    candidate.compactedInput = undefined;
  }
}

export function saveCompactionCheckpoint(entry: ConnectionEntry): void {
  if (
    !entry.checkpointKey
    || !entry.requestInput
    || !entry.expectedAssistant
    || !entry.compactedInput
  ) return;
  const checkpoint: HydratedCompactionCheckpoint = {
    connectionId: entry.debugId,
    lineageId: entry.lineageId,
    lineageKey: entry.lineageKey,
    key: entry.checkpointKey,
    requestInput: entry.requestInput,
    expectedAssistant: entry.expectedAssistant,
    requestInputHashes: entry.requestInputHashes
      ?? entry.requestInput.map(conversationItemHash),
    requestInputKinds: entry.requestInputKinds
      ?? entry.requestInput.map(conversationItemKind),
    expectedAssistantHashes: entry.expectedAssistantHashes
      ?? entry.expectedAssistant.map(conversationItemHash),
    expectedAssistantKinds: entry.expectedAssistantKinds
      ?? entry.expectedAssistant.map(conversationItemKind),
    queuedEventHashes: entry.queuedEventHashes ?? [],
    compactedInput: entry.compactedInput,
    lastInputTokens: entry.lastInputTokens,
    postCompactionInputTokens: entry.postCompactionInputTokens,
    nextCompactionInputTokens: entry.nextCompactionInputTokens,
    claudeCompactionSummaryHash: entry.claudeCompactionSummaryHash,
    promptFieldHashes: entry.promptFieldHashes,
    instructionsSnapshot: entry.instructionsSnapshot,
    lastUsedAt: entry.lastUsedAt,
    ttlMs: entry.checkpointStoreDir
      ? RESPONSES_COMPACTION_DURABLE_CHECKPOINT_TTL_MS
      : RESPONSES_COMPACTION_CHECKPOINT_TTL_MS,
    checkpointStoreDir: entry.checkpointStoreDir,
  };
  persistCompactionCheckpoint(checkpoint, entry.debug);
}

export function persistCompactionCheckpoint(
  checkpoint: HydratedCompactionCheckpoint,
  debug: (message: string) => void,
): boolean {
  if (!checkpoint.checkpointStoreDir) {
    upsertCompactionCheckpoint(checkpoint);
    return false;
  }
  try {
    const persisted = saveStoredResponsesCheckpoint(checkpoint.checkpointStoreDir, {
        checkpointKey: checkpoint.key,
        lineageKey: checkpoint.lineageKey,
        requestInputHashes: checkpoint.requestInputHashes,
        requestInputKinds: checkpoint.requestInputKinds,
        expectedAssistantHashes: checkpoint.expectedAssistantHashes,
        expectedAssistantKinds: checkpoint.expectedAssistantKinds,
        queuedEventHashes: checkpoint.queuedEventHashes,
        compactedInput: checkpoint.compactedInput,
        lastInputTokens: checkpoint.lastInputTokens,
        postCompactionInputTokens: checkpoint.postCompactionInputTokens,
        nextCompactionInputTokens: checkpoint.nextCompactionInputTokens,
        claudeCompactionSummaryHash: checkpoint.claudeCompactionSummaryHash,
        promptFieldHashes: checkpoint.promptFieldHashes,
        lastUsedAt: checkpoint.lastUsedAt,
    }, MAX_COMPACTION_CHECKPOINTS_PER_PARTITION, MAX_COMPACTION_CHECKPOINTS);
    if (!persisted) {
      debug('compact checkpoint exceeded 64 MiB durable store size cap');
      upsertCompactionCheckpoint(checkpoint);
      return false;
    }
    // Keep only a small hot set. Older durable payloads are hydrated after
    // their lightweight lineage metadata matches.
    upsertCompactionCheckpoint(checkpoint);
    return persisted;
  } catch (error) {
    debug(`compact checkpoint persistence unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function hydrateCompactionCheckpoint(
  checkpoint: CompactionCheckpoint,
  now = Date.now(),
): HydratedCompactionCheckpoint | undefined {
  let compactedInput = checkpoint.compactedInput;
  if (compactedInput === undefined && checkpoint.checkpointStoreDir) {
    compactedInput = loadStoredResponsesCheckpoint(
      checkpoint.checkpointStoreDir,
      checkpoint.key,
      checkpoint.lineageKey,
    )?.compactedInput;
  }
  if (compactedInput === undefined) return undefined;
  const hydrated: HydratedCompactionCheckpoint = {
    ...checkpoint,
    compactedInput,
    lastUsedAt: Math.max(checkpoint.lastUsedAt, now),
  };
  upsertCompactionCheckpoint(hydrated);
  return hydrated;
}

function refreshChangedStoredCheckpoint(
  directory: string,
  file: StoredResponsesCheckpointFile,
  existing: CompactionCheckpoint,
  requestedCheckpointKey: string | undefined,
): void {
  if (
    existing.checkpointStoreMtimeMs === file.mtimeMs
    || file.checkpointKey !== requestedCheckpointKey
  ) return;
  const stored = loadStoredResponsesCheckpoint(directory, file.checkpointKey, file.lineageKey);
  if (!stored || stored.lastUsedAt <= existing.lastUsedAt) {
    existing.checkpointStoreMtimeMs = file.mtimeMs;
    return;
  }
  upsertCompactionCheckpoint({
    ...existing,
    compactedInput: undefined,
    requestInputHashes: stored.requestInputHashes,
    requestInputKinds: stored.requestInputKinds,
    expectedAssistantHashes: stored.expectedAssistantHashes,
    expectedAssistantKinds: stored.expectedAssistantKinds,
    queuedEventHashes: stored.queuedEventHashes,
    lastInputTokens: stored.lastInputTokens,
    postCompactionInputTokens: stored.postCompactionInputTokens,
    nextCompactionInputTokens: stored.nextCompactionInputTokens,
    claudeCompactionSummaryHash: stored.claudeCompactionSummaryHash,
    promptFieldHashes: stored.promptFieldHashes,
    lastUsedAt: stored.lastUsedAt,
    checkpointStoreMtimeMs: file.mtimeMs,
  });
}

export function syntheticClaudeCompactionSummary(checkpointId: string): string {
  return '<summary>Context compacted natively by OpenAI and retained in Clodex '
    + `checkpoint ${checkpointId}. Continue from the attached native context.</summary>`;
}

export function syntheticAssistantMessage(itemId: string, text: string): JsonObject {
  return {
    type: 'message',
    id: itemId,
    status: 'completed',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text,
      annotations: [],
    }],
  };
}

export function syntheticClaudeCompactionResponse(
  responseId: string,
  assistantItem: JsonObject,
  text: string,
  usage: ResponsesCompactionUsage | undefined,
): Response {
  const itemId = isString(assistantItem.id) ? assistantItem.id : '';
  const normalizedUsage = {
    input_tokens: usage?.inputTokens ?? 0,
    input_tokens_details: {
      cached_tokens: usage?.cachedTokens ?? 0,
      cache_write_tokens: usage?.cacheWriteTokens ?? 0,
    },
    output_tokens: usage?.outputTokens ?? 0,
  };
  const events = [
    {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...assistantItem, content: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      item_id: itemId,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      output_index: 0,
      content_index: 0,
      item_id: itemId,
      text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: assistantItem,
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [assistantItem],
        usage: normalizedUsage,
      },
    },
  ];
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

export function loadCompactionCheckpointStore(
  directory: string | undefined,
  now: number,
  requestedCheckpointKey?: string,
): void {
  if (!directory) return;
  try {
    if (now >= (checkpointStoreNextScanAt.get(directory) ?? 0)) {
      const files = listStoredResponsesCheckpointFiles(
        directory,
        now,
        RESPONSES_COMPACTION_DURABLE_CHECKPOINT_TTL_MS,
      );
      const liveFiles = new Set(files.map(file => `${file.checkpointKey}:${file.lineageKey}`));
      for (const [key, checkpoints] of compactionCheckpoints) {
        const retained = checkpoints.filter(checkpoint => (
          checkpoint.checkpointStoreDir !== directory
          || liveFiles.has(`${checkpoint.key}:${checkpoint.lineageKey}`)
        ));
        if (retained.length) compactionCheckpoints.set(key, retained);
        else compactionCheckpoints.delete(key);
      }
      for (const file of files) {
        const existing = (compactionCheckpoints.get(file.checkpointKey) ?? [])
          .find(checkpoint => checkpoint.lineageKey === file.lineageKey);
        if (existing) {
          refreshChangedStoredCheckpoint(directory, file, existing, requestedCheckpointKey);
          continue;
        }
        upsertCompactionCheckpoint({
          connectionId: 0,
          lineageId: allocateLineageDebugId(),
          lineageKey: file.lineageKey,
          key: file.checkpointKey,
          requestInputHashes: [],
          requestInputKinds: [],
          expectedAssistantHashes: [],
          expectedAssistantKinds: [],
          queuedEventHashes: [],
          lastUsedAt: file.mtimeMs,
          ttlMs: RESPONSES_COMPACTION_DURABLE_CHECKPOINT_TTL_MS,
          checkpointStoreDir: directory,
          checkpointStoreMtimeMs: file.mtimeMs,
        });
      }
      checkpointStoreNextScanAt.set(directory, now + CHECKPOINT_STORE_RESCAN_INTERVAL_MS);
    }
    if (requestedCheckpointKey) {
      for (const checkpoint of checkpointEntries(requestedCheckpointKey)) {
        if (checkpoint.requestInputHashes.length > 0 || checkpoint.checkpointStoreDir !== directory) continue;
        const stored = loadStoredResponsesCheckpoint(directory, checkpoint.key, checkpoint.lineageKey);
        if (!stored) continue;
        upsertCompactionCheckpoint({
          ...checkpoint,
          requestInputHashes: stored.requestInputHashes,
          requestInputKinds: stored.requestInputKinds,
          expectedAssistantHashes: stored.expectedAssistantHashes,
          expectedAssistantKinds: stored.expectedAssistantKinds,
          queuedEventHashes: stored.queuedEventHashes,
          lastInputTokens: stored.lastInputTokens,
          postCompactionInputTokens: stored.postCompactionInputTokens,
          nextCompactionInputTokens: stored.nextCompactionInputTokens,
          claudeCompactionSummaryHash: stored.claudeCompactionSummaryHash,
          promptFieldHashes: stored.promptFieldHashes,
          lastUsedAt: Math.max(checkpoint.lastUsedAt, stored.lastUsedAt),
        });
      }
    }
  } catch {
    // Do not cache a failed scan. The next request retries recovery while
    // normal inference remains available.
    checkpointStoreNextScanAt.delete(directory);
  }
}

export function registerEntry(entry: ConnectionEntry): void {
  if (!entry.key) return;
  let entries = connections.get(entry.key);
  if (!entries) {
    entries = new Set();
    connections.set(entry.key, entries);
  }
  entries.add(entry);
}

export function unregisterEntry(entry: ConnectionEntry): void {
  if (!entry.key) return;
  const entries = connections.get(entry.key);
  if (!entries) return;
  entries.delete(entry);
  if (entries.size === 0) connections.delete(entry.key);
}

export function debugKey(key: string | undefined): string {
  return key ? key.slice(0, 12) : 'none';
}

export function emitDiagnostic(
  options: ResponsesWebSocketFetchOptions,
  event: { event: string } & JsonObject,
  correlation = diagnosticContext.getStore(),
): void {
  if (!options.onDiagnostic) return;
  try {
    const diagnostic = {
      ...event,
      requestId: correlation?.requestId,
      claudeSessionId: correlation?.claudeSessionId,
    };
    options.onDiagnostic(diagnostic);
  } catch {
    // Diagnostics must never alter inference behavior.
  }
}

/** Test-only cleanup, also useful for preventing leaked fake sockets. */
export function resetResponsesWebSocketConnectionsForTests(): void {
  for (const entry of connectionEntries()) {
    try { entry.socket.close(); } catch { /* ignore */ }
  }
  connections.clear();
  compactionCheckpoints.clear();
  checkpointStoreNextScanAt.clear();
  nextConnectionDebugId = 1;
  nextLineageDebugId = 1;
}

/** Normalize the SDK's HeadersInit into a plain record for `ws`. */
