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
// Bound decoded SSE waiting for a downstream reader before applying TCP backpressure.
export const RESPONSES_WS_STREAM_HIGH_WATER_MARK_BYTES = 256 * 1024;
export const RESPONSES_COMPACTION_RETAINED_USER_TOKENS = 64_000;
export const RESPONSES_CHECKPOINT_MISS_FALLBACK_TOKENS = 400_000;
export const RESPONSES_COMPACTION_CHECKPOINT_TTL_MS = 30 * 60_000;

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
  now?: () => number;
  /** Opt-in structured transport diagnostics; never receives conversation content. */
  onDiagnostic?: (event: ResponsesWebSocketDiagnosticEvent) => void;
}

export interface ResponsesWebSocketDiagnosticEvent extends JsonObject {
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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type RawData = Buffer | ArrayBuffer | Buffer[];

export interface ResponsesWebSocket {
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  pause(): boolean;
  resume(): boolean;
  on(event: 'open', listener: () => void): this;
  on(event: 'unexpected-response', listener: (request: import('node:http').ClientRequest, response: import('node:http').IncomingMessage) => void): this;
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
  compactedInputBase?: JsonValue[];
  /** Pre-compaction head retained until the rebased request completes. */
  supersededEntry?: ConnectionEntry;
  /** This request is Claude Code's own portable-summary compaction turn. */
  claudeCompactionRequest?: boolean;
  /** Portable summary anchor inherited by a continuation of compacted state. */
  claudeCompactionSummaryHash?: string;
  /** Claude-owned queued events already committed to the selected Responses lineage. */
  queuedEventHashes?: string[];
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
  /** Establish a new anti-loop threshold from this response's measured input. */
  establishCompactionRearm?: boolean;
  compactThreshold?: number;
  contextWindow?: number;
  postCompactionInputTokens?: number;
  nextCompactionInputTokens?: number;
  pendingEvents: JsonValue[];
  emittedModelData: boolean;
  transportRetryPending: boolean;
  overflowRecoveryPending: boolean;
  overflowRetried: boolean;
  recoverContextOverflow?: (entry: ConnectionEntry, ctx: RequestContext) => Promise<void>;
  outputByIndex: Map<number, OutputAccumulator>;
  outputIndexByItemId: Map<string, number>;
  emitDiagnostic?: (event: { event: string } & JsonObject) => void;
  entry?: ConnectionEntry;
  createReplacement: () => ConnectionEntry;
  abortCleanup?: () => void;
  settled?: Promise<void>;
  resolveSettled?: () => void;
}

export interface ConnectionEntry {
  debugId: number;
  /** Logical conversation lineage; changes when a physical socket is recycled. */
  lineageId: number;
  lineageKey: string;
  key?: string;
  checkpointKey?: string;
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
  requestInput?: JsonValue[];
  expectedAssistant?: JsonValue[];
  /** Canonical item hashes cached when this conversation head is completed. */
  requestInputHashes?: string[];
  requestInputKinds?: string[];
  expectedAssistantHashes?: string[];
  expectedAssistantKinds?: string[];
  queuedEventHashes?: string[];
  compactedInput?: JsonValue[];
  lastInputTokens?: number;
  postCompactionInputTokens?: number;
  nextCompactionInputTokens?: number;
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
  requestInput: JsonValue[];
  expectedAssistant: JsonValue[];
  requestInputHashes: string[];
  requestInputKinds: string[];
  expectedAssistantHashes: string[];
  expectedAssistantKinds: string[];
  queuedEventHashes: string[];
  compactedInput: JsonValue[];
  lastInputTokens?: number;
  postCompactionInputTokens?: number;
  nextCompactionInputTokens?: number;
  claudeCompactionSummaryHash?: string;
  promptFieldHashes?: Record<string, string>;
  instructionsSnapshot?: string;
  lastUsedAt: number;
  ttlMs: number;
}
