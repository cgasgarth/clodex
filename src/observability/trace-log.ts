// src/observability/trace-log.ts — debug log paths under ~/.clodex/logs/ with secret redaction

import {
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { appendFile, chmod, stat, truncate } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getLogsPath } from '../config/paths.js';
import { isCredentialBearingHeader } from '../credentials/headers.js';
import type { ApiProcessingMode } from '../daemon/api-pricing.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOG_FLUSH_INTERVAL_MS = 50;
const LOG_BATCH_BYTES = 64 * 1024;
export const TRACE_LOG_MAX_BYTES = 50 * 1024 * 1024;

export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | DiagnosticValue[]
  | DiagnosticRecord;

export interface DiagnosticRecord {
  [key: string]: DiagnosticValue;
}

/** Copy a typed JSON request object into the diagnostic record contract. */
export function diagnosticRecord<Value extends object>(value: Value): DiagnosticRecord {
  return Object.fromEntries(Object.entries(value));
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === 'string';
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === 'number';
}

function isBoolean<Value>(value: Value): value is Value & boolean {
  return typeof value === 'boolean';
}

function isDiagnosticRecord<Value>(value: Value): value is Value & DiagnosticRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface PendingLogWrites {
  lines: string[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  writing: Promise<void>;
  prepared: boolean;
}

const pendingLogWrites = new Map<string, PendingLogWrites>();

function pendingLog(path: string): PendingLogWrites {
  let pending = pendingLogWrites.get(path);
  if (!pending) {
    pending = { lines: [], bytes: 0, writing: Promise.resolve(), prepared: false };
    pendingLogWrites.set(path, pending);
  }
  return pending;
}

async function flushPendingLog(path: string, pending: PendingLogWrites): Promise<void> {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
  if (pending.lines.length > 0) {
    const batch = pending.lines.join('');
    pending.lines = [];
    pending.bytes = 0;
    pending.writing = pending.writing.then(async () => {
      try {
        const current = await stat(path);
        if (current.size + Buffer.byteLength(batch) > TRACE_LOG_MAX_BYTES) {
          await truncate(path, 0);
        }
      } catch (error) {
        // SAFETY: Node file-system errors expose `code`; any other value is rethrown.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await appendFile(path, batch, { encoding: 'utf8', mode: FILE_MODE });
      if (!pending.prepared) {
        await chmod(path, FILE_MODE);
        pending.prepared = true;
      }
    }).catch(() => {
      // Logging must never alter inference behavior.
    });
  }
  await pending.writing;
  if (pending.lines.length > 0) await flushPendingLog(path, pending);
}

/** Flush queued trace records. Daemon shutdown and tests use this durability boundary. */
export async function flushTraceLogs(path?: string): Promise<void> {
  if (path) {
    const pending = pendingLogWrites.get(path);
    if (pending) await flushPendingLog(path, pending);
    return;
  }
  await Promise.all(
    [...pendingLogWrites].map(([logPath, pending]) => flushPendingLog(logPath, pending)),
  );
}

const PROXY_DEBUG_LOG = 'proxy-debug.log';
const PROVIDER_DEBUG_LOG = 'provider-debug.log';
const INFERENCE_REQUEST_LOG = 'inference-requests.jsonl';
export const INFERENCE_PROGRESS_INTERVAL_MS = 30_000;
const INFERENCE_SESSION_DIR = 'sessions';
let inferenceSessionSequence = 0;
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeClaudeSessionId<Value>(value: Value): string | undefined {
  return isString(value) && CLAUDE_SESSION_ID_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

function ensureLogsDir(): string {
  const dir = getLogsPath();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort
  }
  return dir;
}

export function getProxyDebugLogPath(): string {
  return join(ensureLogsDir(), PROXY_DEBUG_LOG);
}

export function getProviderDebugLogPath(): string {
  return join(ensureLogsDir(), PROVIDER_DEBUG_LOG);
}

export function getInferenceRequestLogPath(): string {
  return join(ensureLogsDir(), INFERENCE_REQUEST_LOG);
}

/** Create a collision-resistant log path for one short-lived process. */
export function getSessionLogPath(label = 'session', extension = 'log'): string {
  const dir = join(ensureLogsDir(), INFERENCE_SESSION_DIR);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort
  }
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'proxy';
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'log';
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  const sequence = inferenceSessionSequence++;
  return join(dir, `${timestamp}-${safeLabel}-pid${process.pid}-${sequence}.${safeExtension}`);
}

/** Create a collision-resistant JSONL path for one short-lived proxy process. */
export function getInferenceSessionLogPath(label = 'proxy'): string {
  return getSessionLogPath(label, 'jsonl');
}

const REQUEST_PREVIEW_ENV = 'CLODEX_LOG_REQUEST_PREVIEW';
const REQUEST_PREVIEW_MAX = 240;
const RESPONSE_ERROR_MAX = 2_000;

function compactLogValue(value: string, max = 500): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactLogValueWithMarker(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  const marker = ' [truncated]';
  return compact.slice(0, max - marker.length) + marker;
}

function systemPreview<Value>(system: Value): string | undefined {
  if (isString(system)) return compactLogValue(system, REQUEST_PREVIEW_MAX) || undefined;
  if (!Array.isArray(system)) return undefined;
  // SAFETY: Anthropic system arrays are JSON values before preview extraction.
  const blocks = system as DiagnosticValue[];
  const text = blocks
    .map(block => {
      if (isString(block)) return block;
      return isDiagnosticRecord(block) && isString(block.text) ? block.text : '';
    })
    .filter(Boolean)
    .join(' ');
  return compactLogValue(text, REQUEST_PREVIEW_MAX) || undefined;
}

function inlineSystemPreview<Value>(messages: Value): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isDiagnosticRecord(message) || message.role !== 'system') continue;
    const preview = systemPreview(message.content);
    if (preview) return preview;
  }
  return undefined;
}

interface MessageContentSummary {
  preview?: string;
  blockSummary?: string;
}

function summarizeMessageContent<Value>(
  role: string,
  content: Value,
): MessageContentSummary {
  if (isString(content)) return { preview: content };
  if (!Array.isArray(content)) return {};
  const blocks = content.filter(
    isDiagnosticRecord,
  );
  const text = blocks
    .filter(block => block.type === 'text' && isString(block.text))
    .map(block => isString(block.text) ? block.text : '')
    .join(' ');
  if (text.trim()) return { preview: text };
  const blockTypes = [...new Set(
    blocks.map(block => isString(block.type) ? block.type : 'unknown'),
  )];
  return blockTypes.length > 0
    ? { blockSummary: `${role}: [${blockTypes.join(', ')}]` }
    : {};
}

export function getLatestMessagePreview<Messages, System>(
  messages: Messages,
  system?: System,
): string | undefined {
  let blockSummary: string | undefined;
  if (Array.isArray(messages) && messages.length > 0) {
    const message = messages[messages.length - 1];
    if (isDiagnosticRecord(message)) {
      const role = isString(message.role) ? message.role : 'message';
      const summary = summarizeMessageContent(role, message.content);
      blockSummary = summary.blockSummary;
      const compact = summary.preview
        ? compactLogValue(summary.preview, REQUEST_PREVIEW_MAX)
        : '';
      if (compact) return `${role}: ${compact}`;
    }
  }

  const systemText = systemPreview(system) ?? inlineSystemPreview(messages);
  if (!systemText) return blockSummary;
  const preview = blockSummary
    ? `${blockSummary} | system: ${systemText}`
    : `system: ${systemText}`;
  return compactLogValue(preview, REQUEST_PREVIEW_MAX + 20);
}

export interface InferenceRequestLogEntry {
  requestId?: string;
  claudeSessionId?: string;
  accountId?: string;
  processingMode?: ApiProcessingMode;
  modelId: string;
  resolvedModelId?: string;
  provider: string;
  effort?: string;
  route: 'passthrough' | 'translated';
  stream?: boolean;
  requestPreview?: string;
}

export interface InferenceResponseErrorLogEntry {
  requestId?: string;
  claudeSessionId?: string;
  claudeAgentId?: string;
  modelId: string;
  provider: string;
  route: 'passthrough' | 'translated';
  statusCode: number;
  errorContent?: string;
  isRetryable?: boolean;
  attemptCount?: number;
  partialResponse?: boolean;
  replaySafe?: boolean;
  recoveryAction?: InferenceRecoveryAction;
}

type InferenceRecoveryAction =
  | 'client_retry_request'
  | 'client_auto_retry_turn'
  | 'client_retry_turn'
  | 'none';

export interface InferenceRouteUnavailableLogEntry {
  requestId: string;
  modelId: string;
  statusCode: number;
}

type InferenceResponseLifecycleEvent =
  | 'translation_dispatched'
  | 'translation_started'
  | 'translation_progress'
  | 'translation_retrying'
  | 'translation_completed'
  | 'translation_cancelled'
  | 'translation_failed'
  | 'response_started'
  | 'response_progress'
  | 'response_completed'
  | 'response_failed'
  | 'response_client_disconnected'
  | 'response_usage';

export type InferenceResponsePhase =
  | 'preparing_translation'
  | 'waiting_for_sdk'
  | 'translating'
  | 'waiting_for_headers'
  | 'waiting_for_first_byte'
  | 'streaming'
  | 'delivering';

export type InferenceFailureSource =
  | 'adapter_request_error'
  | 'adapter_request_close'
  | 'adapter_response_error'
  | 'adapter_response_aborted'
  | 'adapter_response_close';

type InferenceTerminationSource =
  | 'downstream_client'
  | 'local_shutdown'
  | 'upstream_failure';

export interface InferenceResponseLifecycleLogEntry {
  event: InferenceResponseLifecycleEvent;
  requestId: string;
  claudeSessionId?: string;
  accountId?: string;
  processingMode?: ApiProcessingMode;
  modelId: string;
  resolvedModelId?: string;
  provider: string;
  route: 'passthrough' | 'translated';
  statusCode?: number;
  phase?: InferenceResponsePhase;
  durationMs?: number;
  timeToFirstByteMs?: number;
  idleMs?: number;
  bytes?: number;
  chunks?: number;
  sdkParts?: number;
  sdkIdleMs?: number;
  translatedBytes?: number;
  translatedChunks?: number;
  retryAttempt?: number;
  retryLimit?: number;
  discardedBytes?: number;
  outputIdleMs?: number;
  usageStage?: 'message_start' | 'message_delta';
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  lastPartType?: string;
  errorType?: string;
  errorCode?: string;
  errorSignature?: string;
  failureSource?: InferenceFailureSource;
  terminationSource?: InferenceTerminationSource;
  partialResponse?: boolean;
  replaySafe?: boolean;
  recoveryAction?: InferenceRecoveryAction;
  cancellationReason?: 'downstream_client_abort';
}

type ProxyLifecycleEvent =
  | 'proxy_started'
  | 'proxy_stopping'
  | 'proxy_stopped'
  | 'proxy_process_exit';

export interface ProxyLifecycleLogEntry {
  event: ProxyLifecycleEvent;
  pid: number;
  parentPid?: number;
  host?: string;
  port?: number;
  adapterPort?: number;
  inheritedProxyPort?: number;
  exitCode?: number;
  reason?: string;
}

export interface WebSocketDiagnosticRequestLogEntry {
  requestId: string;
  claudeSessionId?: string;
  provider?: string;
  route?: 'passthrough' | 'translated';
  headers: Record<string, string | string[] | undefined>;
  body: DiagnosticRecord;
}

export type InferenceTraceEvent =
  | { kind: 'request'; entry: InferenceRequestLogEntry }
  | { kind: 'lifecycle'; entry: InferenceResponseLifecycleLogEntry }
  | { kind: 'upstream_error'; entry: InferenceResponseErrorLogEntry }
  | { kind: 'route_unavailable'; entry: InferenceRouteUnavailableLogEntry }
  | { kind: 'websocket'; entry: DiagnosticRecord };

const inferenceTraceSubscribers = new Set<(event: InferenceTraceEvent) => void>();

/** Process-local observability hook used by the persistent daemon. */
export function subscribeInferenceTrace(
  subscriber: (event: InferenceTraceEvent) => void,
): () => void {
  inferenceTraceSubscribers.add(subscriber);
  return () => inferenceTraceSubscribers.delete(subscriber);
}

function publishInferenceTrace(event: InferenceTraceEvent): void {
  for (const subscriber of inferenceTraceSubscribers) {
    try {
      subscriber(event);
    } catch {
      // Observability must never alter inference behavior.
    }
  }
}

const REDACTED_DIAGNOSTIC_HEADER = '[REDACTED]';
const CONVERSATION_BODY_FIELDS = new Set(['system', 'messages', 'tools']);

function canonicalDiagnosticValue<Value>(
  value: Value,
): Value | DiagnosticValue[] | DiagnosticRecord {
  if (Array.isArray(value)) return value.map(canonicalDiagnosticValue);
  if (!isDiagnosticRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalDiagnosticValue(child)]),
  );
}

function stringifyDiagnostic<Value>(value: Value): string | undefined {
  return JSON.stringify(value);
}

function diagnosticHash<Value>(value: Value): string {
  return createHash('sha256')
    .update(stringifyDiagnostic(canonicalDiagnosticValue(value)) ?? 'undefined')
    .digest('hex')
    .slice(0, 16);
}

function diagnosticBytes<Value>(value: Value): number {
  return Buffer.byteLength(stringifyDiagnostic(value) ?? '');
}

/** Preserve every inbound header except credential-bearing values. */
interface SanitizedDiagnosticHeaders {
  [key: string]: string | string[];
}

function sanitizeDiagnosticHeaders(
  headers: Record<string, string | string[] | undefined>,
): SanitizedDiagnosticHeaders {
  const out: SanitizedDiagnosticHeaders = {};
  for (const [name, value] of Object.entries(headers).toSorted(([left], [right]) => left.localeCompare(right))) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = isCredentialBearingHeader(name)
      ? REDACTED_DIAGNOSTIC_HEADER
      : value;
  }
  return out;
}

function contentKinds<Value>(content: Value): string[] {
  if (isString(content)) return ['text'];
  if (!Array.isArray(content)) {
    if (content === undefined) return ['undefined'];
    if (isNumber(content)) return ['number'];
    if (isBoolean(content)) return ['boolean'];
    return ['object'];
  }
  return content.map(item => {
    if (!isDiagnosticRecord(item)) {
      if (isString(item)) return 'string';
      if (isNumber(item)) return 'number';
      if (isBoolean(item)) return 'boolean';
      return 'object';
    }
    return isString(item.type) ? item.type : 'object';
  });
}

/**
 * Capture the complete non-conversation envelope plus hashes/shapes for prompt
 * fields. Hashes make rewinds and harness requests comparable without writing
 * message, system-prompt, tool-description, schema, or tool-result content.
 */
interface DiagnosticRequestSummary extends DiagnosticRecord {
  topLevelKeys: string[];
  parameters: DiagnosticRecord;
  messages: DiagnosticRecord;
  tools: DiagnosticRecord;
}

function summarizeDiagnosticRequestBody(body: DiagnosticRecord): DiagnosticRequestSummary {
  const parameters = Object.fromEntries(
    Object.entries(body).filter(([key]) => !CONVERSATION_BODY_FIELDS.has(key)),
  );
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    topLevelKeys: Object.keys(body).toSorted(),
    parameters,
    system: body.system === undefined ? undefined : {
      hash: diagnosticHash(body.system),
      bytes: diagnosticBytes(body.system),
      blocks: Array.isArray(body.system) ? body.system.length : 1,
    },
    messages: {
      count: messages.length,
      items: messages.map(message => {
        const record = isDiagnosticRecord(message) ? message : {};
        return {
          role: isString(record.role) ? record.role : 'unknown',
          contentKinds: contentKinds(record.content),
          hash: diagnosticHash(message),
          bytes: diagnosticBytes(message),
        };
      }),
    },
    tools: {
      count: tools.length,
      items: tools.map(tool => {
        const record = isDiagnosticRecord(tool) ? tool : {};
        return {
          name: isString(record.name) ? compactLogValue(record.name, 200) : 'unknown',
          descriptionHash: diagnosticHash(record.description),
          schemaHash: diagnosticHash(record.input_schema),
          hash: diagnosticHash(tool),
        };
      }),
    },
  };
}

/** Append privacy-minimal routing metadata, plus an explicitly enabled request preview. */
export function writeInferenceRequestLog(
  path: string,
  entry: InferenceRequestLogEntry,
): void {
  const requestPreview = process.env[REQUEST_PREVIEW_ENV] === '1'
    ? entry.requestPreview
    : undefined;
  const claudeSessionId = safeClaudeSessionId(entry.claudeSessionId);
  const accountId = compactLogValue(entry.accountId ?? '', 100);
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    requestId: entry.requestId ? compactLogValue(entry.requestId, 100) : undefined,
    claudeSessionId,
    accountId: accountId || undefined,
    processingMode: entry.processingMode,
    modelId: compactLogValue(entry.modelId),
    resolvedModelId: entry.resolvedModelId
      ? compactLogValue(entry.resolvedModelId)
      : undefined,
    effort: entry.effort ? compactLogValue(entry.effort, 100) : undefined,
    provider: compactLogValue(entry.provider, 200),
    route: entry.route,
    stream: entry.stream,
    requestPreview: requestPreview
      ? compactLogValue(requestPreview, REQUEST_PREVIEW_MAX + 20)
      : undefined,
  }));
  publishInferenceTrace({ kind: 'request', entry });
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

/** Append privacy-minimal response timing and delivery metadata. */
export function writeInferenceResponseLifecycleLog(
  path: string,
  entry: InferenceResponseLifecycleLogEntry,
): void {
  const claudeSessionId = safeClaudeSessionId(entry.claudeSessionId);
  const accountId = compactLogValue(entry.accountId ?? '', 100);
  const statusCode = nonNegativeInteger(entry.statusCode);
  const durationMs = nonNegativeInteger(entry.durationMs);
  const timeToFirstByteMs = nonNegativeInteger(entry.timeToFirstByteMs);
  const idleMs = nonNegativeInteger(entry.idleMs);
  const bytes = nonNegativeInteger(entry.bytes);
  const chunks = nonNegativeInteger(entry.chunks);
  const sdkParts = nonNegativeInteger(entry.sdkParts);
  const sdkIdleMs = nonNegativeInteger(entry.sdkIdleMs);
  const translatedBytes = nonNegativeInteger(entry.translatedBytes);
  const translatedChunks = nonNegativeInteger(entry.translatedChunks);
  const retryAttempt = nonNegativeInteger(entry.retryAttempt);
  const retryLimit = nonNegativeInteger(entry.retryLimit);
  const discardedBytes = nonNegativeInteger(entry.discardedBytes);
  const outputIdleMs = nonNegativeInteger(entry.outputIdleMs);
  const inputTokens = nonNegativeInteger(entry.inputTokens);
  const outputTokens = nonNegativeInteger(entry.outputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(entry.cacheCreationInputTokens);
  const cacheReadInputTokens = nonNegativeInteger(entry.cacheReadInputTokens);
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: entry.event,
    requestId: compactLogValue(entry.requestId, 100),
    claudeSessionId,
    accountId: accountId || undefined,
    processingMode: entry.processingMode,
    modelId: compactLogValue(entry.modelId),
    resolvedModelId: entry.resolvedModelId
      ? compactLogValue(entry.resolvedModelId)
      : undefined,
    provider: compactLogValue(entry.provider, 200),
    route: entry.route,
    statusCode,
    phase: entry.phase,
    durationMs,
    timeToFirstByteMs,
    idleMs,
    bytes,
    chunks,
    sdkParts,
    sdkIdleMs,
    translatedBytes,
    translatedChunks,
    retryAttempt,
    retryLimit,
    discardedBytes,
    outputIdleMs,
    usageStage: entry.usageStage,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    lastPartType: entry.lastPartType ? compactLogValue(entry.lastPartType, 100) : undefined,
    errorType: entry.errorType ? compactLogValue(entry.errorType, 200) : undefined,
    errorCode: entry.errorCode ? compactLogValue(entry.errorCode, 100) : undefined,
    errorSignature: entry.errorSignature
      ? compactLogValue(entry.errorSignature, 100)
      : undefined,
    failureSource: entry.failureSource,
    terminationSource: entry.terminationSource,
    partialResponse: entry.partialResponse,
    replaySafe: entry.replaySafe,
    recoveryAction: entry.recoveryAction,
    cancellationReason: entry.cancellationReason,
  }));
  publishInferenceTrace({ kind: 'lifecycle', entry });
}

/** Record enough process lifetime metadata to distinguish a dead local proxy from an upstream failure. */
export function writeProxyLifecycleLog(path: string, entry: ProxyLifecycleLogEntry): void {
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: entry.event,
    pid: nonNegativeInteger(entry.pid),
    parentPid: nonNegativeInteger(entry.parentPid),
    host: entry.host ? compactLogValue(entry.host, 200) : undefined,
    port: nonNegativeInteger(entry.port),
    adapterPort: nonNegativeInteger(entry.adapterPort),
    inheritedProxyPort: nonNegativeInteger(entry.inheritedProxyPort),
    exitCode: entry.exitCode === undefined ? undefined : Math.round(entry.exitCode),
    reason: entry.reason ? compactLogValue(entry.reason, 200) : undefined,
  }));
}

/** Write one opt-in request-envelope diagnostic without conversation content. */
export function writeWebSocketDiagnosticRequestLog(
  path: string,
  entry: WebSocketDiagnosticRequestLogEntry,
): void {
  const claudeSessionId = safeClaudeSessionId(entry.claudeSessionId);
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'request_diagnostic',
    requestId: compactLogValue(entry.requestId, 100),
    claudeSessionId,
    provider: entry.provider ? compactLogValue(entry.provider, 200) : undefined,
    route: entry.route,
    headers: sanitizeDiagnosticHeaders(entry.headers),
    body: summarizeDiagnosticRequestBody(entry.body),
  }));
}

/** Append a structured WebSocket transport diagnostic event. */
export function writeWebSocketDiagnosticLog(
  path: string,
  entry: DiagnosticRecord,
): void {
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  }));
  publishInferenceTrace({ kind: 'websocket', entry });
}

/** Append an upstream HTTP failure; response content follows the request-preview opt-in. */
export function writeInferenceResponseErrorLog(
  path: string,
  entry: InferenceResponseErrorLogEntry,
): void {
  const errorContent = process.env[REQUEST_PREVIEW_ENV] === '1'
    ? entry.errorContent
    : undefined;
  const claudeSessionId = safeClaudeSessionId(entry.claudeSessionId);
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'upstream_error',
    requestId: entry.requestId ? compactLogValue(entry.requestId, 100) : undefined,
    claudeSessionId,
    claudeAgentId: entry.claudeAgentId
      ? compactLogValue(entry.claudeAgentId, 100)
      : undefined,
    modelId: compactLogValue(entry.modelId),
    provider: compactLogValue(entry.provider, 200),
    route: entry.route,
    statusCode: entry.statusCode,
    isRetryable: entry.isRetryable,
    attemptCount: entry.attemptCount,
    partialResponse: entry.partialResponse,
    replaySafe: entry.replaySafe,
    recoveryAction: entry.recoveryAction,
    errorContent: errorContent
      ? compactLogValueWithMarker(errorContent, RESPONSE_ERROR_MAX)
      : undefined,
  }));
  publishInferenceTrace({ kind: 'upstream_error', entry });
}

/** Append a local routing-policy rejection without attributing it to an upstream provider. */
export function writeInferenceRouteUnavailableLog(
  path: string,
  entry: InferenceRouteUnavailableLogEntry,
): void {
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'route_unavailable',
    requestId: compactLogValue(entry.requestId, 100),
    modelId: compactLogValue(entry.modelId),
    statusCode: entry.statusCode,
  }));
  publishInferenceTrace({ kind: 'route_unavailable', entry });
}

/** Reset log file and return a writer that redacts secrets. */
export function makeTraceLogger(logPath: string): (message: string) => void {
  resetTraceLog(logPath);
  return (message: string) => writeSecureLogLine(logPath, `${new Date().toISOString()} ${message}`);
}

/** Remove prior session log so --trace shows only the latest run. */
export function resetTraceLog(path: string): void {
  ensureLogsDir();
  const pending = pendingLogWrites.get(path);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingLogWrites.delete(path);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

const MIN_TRACE_SECRET_LENGTH = 8;
const knownTraceSecrets = new Set<string>();

export function registerTraceSecret(value: string): void {
  if (value.trim().length < MIN_TRACE_SECRET_LENGTH) return;
  knownTraceSecrets.add(value);
}

/** Test hook: prevent registered credentials from leaking between test cases. */
export function clearTraceSecrets(): void {
  knownTraceSecrets.clear();
}

const REDACTION_PATTERNS: Array<(line: string) => string> = [
  // Bearer / Authorization headers
  line => line.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]'),
  line => line.replace(/("authorization"\s*:\s*")[^"]+/gi, '$1[REDACTED]'),
  line => line.replace(/(x-api-key"\s*:\s*")[^"]+/gi, '$1[REDACTED]'),
  // Common API key prefixes
  line => line.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'),
  line => line.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, 'sk-ant-[REDACTED]'),
  line => line.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, 'AIza[REDACTED]'),
  line => line.replace(/\bgsk_[A-Za-z0-9]{20,}\b/g, 'gsk_[REDACTED]'),
];

export function redactTraceLine(line: string): string {
  let out = line;
  for (const secret of knownTraceSecrets) {
    out = out.split(secret).join('[REDACTED]');
  }
  for (const apply of REDACTION_PATTERNS) {
    out = apply(out);
  }
  return out;
}

export function redactTraceLog(content: string): string {
  return content.split('\n').map(redactTraceLine).join('\n');
}

export function writeSecureLogLine(path: string, line: string): void {
  const redacted = redactTraceLine(line);
  const value = `${redacted}\n`;
  const pending = pendingLog(path);
  pending.lines.push(value);
  pending.bytes += Buffer.byteLength(value);
  if (pending.bytes >= LOG_BATCH_BYTES) {
    void flushPendingLog(path, pending);
  } else if (!pending.timer) {
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void flushPendingLog(path, pending);
    }, LOG_FLUSH_INTERVAL_MS);
  }
}
