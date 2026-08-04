import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResponseUsage } from './protocol.js';
import type { WebSocketConstructor } from './transport.js';

export const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
export const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete']);
export const FAILURE_EVENT_TYPES = new Set(['error', 'response.failed', 'response.incomplete']);

export const RESPONSES_WS_HARD_TTL_MS = 55 * 60_000;
export const RESPONSES_WS_IDLE_TTL_MS = 30 * 60_000;
export const RESPONSES_WS_NURSERY_IDLE_TTL_MS = 5 * 60_000;
export const RESPONSES_WS_MAX_CONNECTIONS = 32;
// Claude dynamic workflows permit up to 16 concurrent agents. Retain one
// unproven head per possible workflow branch so every agent can establish a
// reusable previous_response_id lineage instead of making the upper half of a
// full-width workflow fall back to disposable sockets.
export const RESPONSES_WS_MAX_NURSERY_CONNECTIONS = 16;
export const RESPONSES_WS_WARM_NURSERY_CONNECTIONS_PER_PARTITION = 2;
export const RESPONSES_COMPACTION_RETAINED_USER_TOKENS = 64_000;
export const RESPONSES_COMPACTION_CHECKPOINT_TTL_MS = 30 * 60_000;
export const RESPONSES_COMPACTION_DURABLE_CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60_000;

export interface ResponsesWebSocketFetchOptions {
  providerId?: string;
  accountId?: string;
  /** Test overrides; production callers should leave these unset. */
  hardTtlMs?: number;
  idleTtlMs?: number;
  nurseryIdleTtlMs?: number;
  maxConnections?: number;
  maxNurseryConnections?: number;
  /** Opt-in token threshold for native compaction. */
  compactThreshold?: number;
  /** Hard model context window. Known-oversized requests are never dispatched. */
  contextWindow?: number;
  /** Test seam for the unary compact request. */
  compactFetch?: typeof fetch;
  /** Test seam; production uses Bun's native WebSocket client. */
  webSocketConstructor?: WebSocketConstructor;
  compactTimeoutMs?: number;
  overflowRecoveryMaxCompactCalls?: number;
  overflowRecoveryMaxContextRejections?: number;
  overflowRecoveryDeadlineMs?: number;
  overflowRecoveryFinalCreateReserveMs?: number;
  /** Private durable store for compacted native-compaction recovery state. */
  checkpointStoreDir?: string;
  now?: () => number;
  /** Opt-in structured transport diagnostics; never receives conversation content. */
  onDiagnostic?: (event: ResponsesWebSocketDiagnosticEvent) => void;
}

export interface ResponsesWebSocketDiagnosticEvent extends Record<string, unknown> {
  event: string;
  requestId?: string;
}

export interface ResponsesWebSocketDiagnosticContext {
  requestId?: string;
  claudeSessionId?: string;
  claudeAgentId?: string;
  estimatedInputTokens?: number;
  forceCompaction?: boolean;
}

export const diagnosticContext = new AsyncLocalStorage<ResponsesWebSocketDiagnosticContext>();

/** Correlate a gateway/proxy request with the lower-level SDK WebSocket fetch. */
export function withResponsesWebSocketDiagnosticContext<T>(
  context: ResponsesWebSocketDiagnosticContext,
  fn: () => T,
): T {
  return diagnosticContext.run(context, fn);
}

export type JsonObject = Record<string, unknown>;
export type RawData = Buffer | ArrayBuffer | Buffer[];

export interface ResponsesWebSocket {
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'unexpected-response', listener: (request: unknown, response: import('node:http').IncomingMessage) => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  _socket?: { unref?: () => void };
}

export interface OutputAccumulator {
  type?: string;
  itemId?: string;
  text: string;
  summaries: Map<number, string>;
  done?: JsonObject;
}

export interface RequestContext {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  originalPayload: JsonObject;
  sendPayload: JsonObject;
  /** Retry payload after a successful native compact call. */
  retryPayload?: JsonObject;
  /** Canonical stateless history from the latest compact item through this input. */
  compactedInputBase?: unknown[];
  /** Pre-compaction head retained until the rebased request completes. */
  supersededEntry?: ConnectionEntry;
  /** This request is Claude Code's own portable-summary compaction turn. */
  claudeCompactionRequest?: boolean;
  claudeAgentId?: string;
  promptFieldHashes: Record<string, string>;
  instructionsSnapshot?: string;
  continued: boolean;
  retried: boolean;
  closed: boolean;
  frameCount: number;
  responseId?: string;
  responseUsage?: ResponseUsage;
  /** Usage from the visible model response only; drives the next context threshold. */
  modelResponseUsage?: ResponseUsage;
  /** Hidden native-compaction usage added to the downstream visible response. */
  usageOffset?: ResponseUsage;
  pendingEvents: unknown[];
  emittedModelData: boolean;
  transportRetryPending: boolean;
  overflowRecoveryPending: boolean;
  overflowRetried: boolean;
  recoverContextOverflow?: (entry: ConnectionEntry, ctx: RequestContext) => Promise<void>;
  outputByIndex: Map<number, OutputAccumulator>;
  outputIndexByItemId: Map<string, number>;
  reasoningPartsByItemId: Map<string, Map<number, ReasoningPartState>>;
  recentUpstreamEventTypes: string[];
  emittedProtocolAnomalies: Set<string>;
  emitDiagnostic?: (event: { event: string } & Record<string, unknown>) => void;
  entry?: ConnectionEntry;
  createReplacement: () => ConnectionEntry;
  abortCleanup?: () => void;
}

type ReasoningPartState = 'active' | 'can_conclude' | 'concluded';

export interface ConnectionEntry {
  debugId: number;
  /** Logical conversation lineage; changes when a physical socket is recycled. */
  lineageId: number;
  lineageKey: string;
  key?: string;
  checkpointKey?: string;
  checkpointStoreDir?: string;
  socket: ResponsesWebSocket;
  persistent: boolean;
  generation: 'nursery' | 'established' | 'isolated';
  open: boolean;
  createdAt: number;
  ttlPausedMs: number;
  inFlightStartedAt?: number;
  lastUsedAt: number;
  inFlight: boolean;
  current?: RequestContext;
  promptFieldHashes?: Record<string, string>;
  instructionsSnapshot?: string;
  responseId?: string;
  requestInput?: unknown[];
  expectedAssistant?: unknown[];
  compactedInput?: unknown[];
  lastInputTokens?: number;
  claudeCompactionSummaryHash?: string;
  claudeAgentId?: string;
  recyclableAgentHead?: boolean;
  options: Required<Pick<ResponsesWebSocketFetchOptions, 'hardTtlMs' | 'idleTtlMs' | 'nurseryIdleTtlMs' | 'maxConnections' | 'now'>>;
  debug: (message: string) => void;
}

export interface CompactionCheckpoint {
  connectionId: number;
  lineageId: number;
  lineageKey: string;
  key: string;
  requestInput?: unknown[];
  expectedAssistant?: unknown[];
  requestInputHashes: string[];
  expectedAssistantHashes: string[];
  expectedAssistantKinds: string[];
  compactedInput?: unknown[];
  lastInputTokens?: number;
  claudeCompactionSummaryHash?: string;
  promptFieldHashes?: Record<string, string>;
  instructionsSnapshot?: string;
  lastUsedAt: number;
  ttlMs: number;
  checkpointStoreDir?: string;
  checkpointStoreMtimeMs?: number;
}

export type HydratedCompactionCheckpoint = CompactionCheckpoint & { compactedInput: unknown[] };
