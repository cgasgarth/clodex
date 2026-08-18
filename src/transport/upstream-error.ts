// Short user-facing messages from SDK/upstream failures — no stack traces in Codex TUI.

import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import { APICallError, RetryError } from 'ai';
import {
  diagnosticRecord,
  type DiagnosticRecord,
  type DiagnosticValue,
} from '../observability/trace-log.js';

interface ApiCallLike {
  message?: string;
  statusCode?: number;
  responseBody?: string;
  data?: { error?: { message?: string; type?: string; code?: string } };
  lastError?: { message?: string; statusCode?: number };
  errors?: Array<{ message?: string; statusCode?: number }>;
}

export interface SdkUpstreamErrorDetails {
  statusCode?: number;
  errorContent: string;
  isRetryable: boolean;
  attemptCount: number;
  /** Client backoff hint (seconds); only present on rate-limit (429) failures. */
  retryAfterSeconds?: number;
  transportCode?: 'websocket_transport_error';
}

/** Default downstream backoff hint when the upstream throttle gives none. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;
/**
 * Upper bound for any retry-after hint clodex produces or forwards. Keeps the
 * AI SDK's bounded backoff (default maxRetries=2) and downstream clients well
 * clear of clodex's 120s no-event stream abort.
 */
const MAX_RETRY_AFTER_SECONDS = 60;

/** Clamp a retry-after hint to [0, 60]s; missing/invalid values become the 5s default. */
export function clampRetryAfterSeconds(value?: number): number {
  if (!isNumber(value) || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return Math.min(Math.round(value), MAX_RETRY_AFTER_SECONDS);
}

/**
 * Recover a backoff hint from message prose. The OAuth WebSocket transport's
 * synthetic error frames can only carry the hint this way — the AI SDK's chunk
 * schema is a closed zod object, so it strips `retry_after_seconds`.
 */
function retryAfterFromText(message: DiagnosticValue): number | undefined {
  if (!isString(message)) return undefined;
  const match = /retry after (\d+)s\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function numericRetryAfterSeconds(inner: InstanceType<typeof APICallError>): number | undefined {
  const data = inner.data && isObject(inner.data) ? diagnosticRecord(inner.data) : undefined;
  const error = asRecord(data?.error);
  const fromBody = error?.retry_after_seconds;
  if (isNumber(fromBody) && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const fromHeader = inner.responseHeaders?.['retry-after'];
  if (isString(fromHeader) && /^\d+$/.test(fromHeader.trim())) return Number(fromHeader.trim());
  for (const message of [error?.message, inner.message]) {
    const fromText = retryAfterFromText(message);
    if (fromText !== undefined) return fromText;
  }
  return undefined;
}

// ── Provider stream error frames ────────────────────────────────────────────
//
// `@ai-sdk/openai` handles a stream failure in one of two ways depending on
// WHEN it arrives:
//
//   before the first output chunk — `throwIfOpenAIStreamErrorBeforeOutput`
//     converts the frame into a real APICallError with a mapped statusCode, so
//     the APICallError branch below already handles it correctly.
//   after output has started — the frame is enqueued verbatim as
//     `{type:'error', error: <payload>}` and our adapter rethrows that payload,
//     which is a plain object with no top-level `message` or `statusCode`.
//
// Only the second case reaches here, and before this recovery existed it
// collapsed to the generic fallback string plus a fabricated HTTP 500 —
// discarding the provider's own message on every mid-stream failure.
//
// The payload shapes the SDK actually produces:
//
//   {type:'error', sequence_number, error:{type, code, message, param}}   nested
//   {type:'response.failed', sequence_number, response:{error:{code, message}}}
//   {type:'error', sequence_number, code, message, param}                 flat
//   {type, code, message, param}                       bare (chat completions)

const MAX_CLIENT_MESSAGE_CHARS = 240;

/** Chunk discriminators — never an error class, so they must not map to a status. */
const CHUNK_DISCRIMINATOR_TYPES = new Set(['error', 'response.failed']);

interface ProviderErrorFrame {
  message: string;
  statusCode: number;
  /** Decided from the frame's own code/type, never from loose prose. */
  contextLengthExceeded: boolean;
  retryAfterSeconds?: number;
  transportCode?: 'websocket_transport_error';
  /** Full payload, for the diagnostic log only — never the user-facing message. */
  serialized: string;
}

function asRecord(cause: unknown): DiagnosticRecord | undefined {
  return isObject(cause) && !Array.isArray(cause)
    ? diagnosticRecord(cause)
    : undefined;
}

function nonEmptyString(record: DiagnosticRecord, key: string): string | undefined {
  const value = record[key];
  return isString(value) && value.trim() !== '' ? value : undefined;
}

/**
 * `code` is `string | number | null` in the SDK's error schema, and the SDK's
 * own `getStatusCode` reads both forms. Reading only strings dropped a numeric
 * `code: 503` on the floor and classified it 500 — reintroducing, for that
 * payload, the pre/post-output split this module exists to remove.
 *
 * Any finite number is kept, not just an integer in HTTP range: the SDK folds
 * the raw value into its discriminator either way, and `frameStatusCode`
 * already rejects anything that is not three digits before using it as a
 * status. Filtering earlier would only diverge from the SDK.
 */
function errorCodeValue(record: DiagnosticRecord): string | undefined {
  const value = record.code;
  if (isNumber(value) && Number.isFinite(value)) return String(value);
  return isString(value) && value.trim() !== '' ? value : undefined;
}

/**
 * Real HTTP status behind a frame.
 *
 * Deliberately mirrors `@ai-sdk/openai`'s own `getStatusCode`: substring
 * discriminators rather than an exact-match table, and 500 when nothing
 * matches. That keeps a mid-stream frame classified IDENTICALLY to the same
 * frame arriving pre-output (which the SDK maps itself), and it degrades
 * gracefully as OpenAI adds codes instead of silently falling out of date.
 *
 * Always returning a status also matters for correctness, not just tidiness:
 * an undefined result would send the recovered message on to the prose
 * sniffing in `upstreamHttpStatus`, where a digit in the provider's own text
 * ("consumed 429000 of 500000 tokens") gets misread as a rate limit.
 *
 * clodex's own synthetic frames set `code` to the stringified status, so that
 * exact channel is preferred over any discriminator.
 */
function frameStatusCode(code: string | undefined, discriminator: string): number {
  if (code !== undefined && /^\d{3}$/.test(code)) {
    const numeric = Number(code);
    if (numeric >= 400 && numeric <= 599) return numeric;
  }
  // Mirrored ordering, quirks included: `invalid_api_key` matches /invalid/
  // before any auth check and so reports 400 here exactly as it does in the
  // SDK. Diverging would reintroduce the pre/post-output split this avoids,
  // and an auth failure cannot reach a mid-stream frame anyway.
  if (/insufficient_quota|rate_limit/.test(discriminator)) return 429;
  if (discriminator.includes('authentication')) return 401;
  if (discriminator.includes('permission')) return 403;
  if (discriminator.includes('not_found')) return 404;
  if (/invalid|bad_request|context_length/.test(discriminator)) return 400;
  if (discriminator.includes('overload')) return 503;
  if (discriminator.includes('timeout')) return 504;
  return 500;
}

/**
 * Context overflow decided from the frame's structured code/type, falling back
 * only to unambiguous message wording.
 *
 * Deliberately stricter than `isContextLengthExceededError`'s prose scan, which
 * matches a bare "context window". Acting on this discards the provider's real
 * message in favour of a synthetic "prompt is too long" that Claude Code parses
 * to drive auto-compaction — so a false positive costs the user conversation
 * history AND hides the error that actually needs fixing.
 */
function frameIsContextLengthExceeded(discriminator: string, message: string): boolean {
  if (/context_length|context_window/.test(discriminator)) return true;
  return /context_length_exceeded|maximum context length|prompt is too long/i.test(message);
}

/** Retryable classes only. A transport failure is transient by definition. */
function frameIsRetryable(frame: Pick<ProviderErrorFrame, 'statusCode' | 'transportCode'>): boolean {
  if (frame.transportCode !== undefined) return true;
  const { statusCode } = frame;
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

/** Parse an AI SDK stream error part into the provider payload it wraps. */
function providerErrorFrame(cause: unknown): ProviderErrorFrame | undefined {
  const outer = asRecord(cause);
  if (!outer) return undefined;

  const nested = asRecord(outer.error) ?? asRecord(asRecord(outer.response)?.error);
  // An unwrapped payload (the flat chunk, and the bare object the chat
  // transport enqueues) needs a positive signal that it is an OpenAI error
  // object rather than an ordinary failure.
  //
  // Provenance is that signal, not field shape. The payload the adapter
  // rethrows is a plain parsed object; the failures that must stay out —
  // socket errors, aborts, undici failures, validation errors — are all `Error`
  // instances. Excluding those lets this mirror the SDK's own predicate
  // exactly for plain objects.
  //
  // Approximating it with field checks instead failed in both directions:
  // demanding a string `type` left `{message, code:'rate_limit_exceeded'}`
  // (429 before first output) classified 500 after it, while accepting a bare
  // `code`/`param` on anything would have swallowed `code: 'ECONNRESET'`.
  // `typeof === 'string'`, not "non-empty": the SDK's schema permits `type: ''`
  // and its predicate accepts any string. Requiring a non-empty one rejected
  // that payload here while the SDK accepted it pre-output — and a rejected
  // payload falls through to the prose sniffing in `upstreamHttpStatus`, which
  // read the digits in "consumed 429000 of 500000 tokens" as a rate limit. So
  // the near-miss did not merely lose metadata, it inverted retryability.
  const unwrapped = !(cause instanceof Error)
    && (isString(outer.type)
      || Object.hasOwn(outer, 'code')
      || Object.hasOwn(outer, 'param'))
    ? outer
    : undefined;
  const payload = nested ?? unwrapped;
  if (!payload) return undefined;

  // The SDK's schema requires only that `message` be a string, so a blank one
  // is still a valid frame whose STATUS is worth recovering — rejecting it
  // outright would report a 429 as a fabricated 500. Recognition keys off the
  // string being present; blank text gets a stand-in. No status in the
  // stand-in: `formatUpstreamError` appends `(HTTP nnn)` itself.
  const rawMessage = payload.message;
  if (!isString(rawMessage)) return undefined;
  const message = rawMessage.trim() !== '' ? rawMessage : 'Provider returned an error';

  const code = errorCodeValue(payload);
  // On an unwrapped chunk `type` is the discriminator ('error'), not an error
  // class; on the bare chat payload it IS the error class. Only the latter may
  // reach the status mapping.
  const rawType = nonEmptyString(payload, 'type');
  const type = rawType !== undefined && CHUNK_DISCRIMINATOR_TYPES.has(rawType) ? undefined : rawType;
  const discriminator = [code, type].filter(value => value !== undefined).join(' ').toLowerCase();
  const statusCode = frameStatusCode(code, discriminator);

  const rawRetryAfter = statusCode === 429
    ? (isNumber(payload.retry_after_seconds) && Number.isFinite(payload.retry_after_seconds)
      && payload.retry_after_seconds >= 0
        ? payload.retry_after_seconds
        : retryAfterFromText(message))
    : undefined;

  let serialized: string;
  try {
    const candidate: unknown = JSON.stringify(payload);
    serialized = isString(candidate) ? candidate : message;
  } catch {
    // Circular or unserializable payload — the message is still worth keeping.
    serialized = message;
  }

  const frame: ProviderErrorFrame = {
    message,
    statusCode,
    contextLengthExceeded: frameIsContextLengthExceeded(discriminator, message),
    serialized,
  };
  if (rawRetryAfter !== undefined) frame.retryAfterSeconds = clampRetryAfterSeconds(rawRetryAfter);
  if (code === 'websocket_transport_error') frame.transportCode = 'websocket_transport_error';
  return frame;
}

/** Unwrap a RetryError before looking for a frame; retries wrap the real payload. */
function frameFromError(cause: unknown): { frame: ProviderErrorFrame; attemptCount: number } | undefined {
  const retry = RetryError.isInstance(cause) ? cause : undefined;
  const frame = providerErrorFrame(retry?.lastError ?? cause);
  return frame ? { frame, attemptCount: retry?.errors.length ?? 1 } : undefined;
}

function boundedTransportCode(cause: unknown): 'websocket_transport_error' | undefined {
  const data = asRecord(cause);
  const error = asRecord(data?.error);
  return error?.code === 'websocket_transport_error'
    ? 'websocket_transport_error'
    : undefined;
}

/** Extract the real HTTP failure from an AI SDK retry wrapper without relying on instanceof. */
export function sdkUpstreamErrorDetails(cause: unknown): SdkUpstreamErrorDetails | undefined {
  const retry = RetryError.isInstance(cause) ? cause : undefined;
  const inner = retry?.lastError ?? cause;
  if (!APICallError.isInstance(inner)) {
    const recovered = frameFromError(cause);
    if (!recovered) return undefined;
    const { frame, attemptCount } = recovered;
    const details: SdkUpstreamErrorDetails = {
      statusCode: frame.statusCode,
      errorContent: frame.serialized,
      isRetryable: frameIsRetryable(frame),
      attemptCount,
    };
    if (frame.retryAfterSeconds !== undefined) details.retryAfterSeconds = frame.retryAfterSeconds;
    if (frame.transportCode !== undefined) details.transportCode = frame.transportCode;
    return details;
  }

  let errorContent = inner.responseBody;
  if (!errorContent && inner.data !== undefined) {
    try {
      errorContent = JSON.stringify(inner.data);
    } catch {
      // Fall through to the SDK's safe message.
    }
  }

  const rawRetryAfter = inner.statusCode === 429 ? numericRetryAfterSeconds(inner) : undefined;
  const retryAfterSeconds = rawRetryAfter === undefined
    ? undefined
    : clampRetryAfterSeconds(rawRetryAfter);
  const transportCode = boundedTransportCode(inner.data);

  const details: SdkUpstreamErrorDetails = {
    statusCode: inner.statusCode,
    errorContent: errorContent || inner.message,
    isRetryable: inner.isRetryable,
    attemptCount: retry?.errors.length ?? 1,
  };
  if (retryAfterSeconds !== undefined) details.retryAfterSeconds = retryAfterSeconds;
  if (transportCode !== undefined) details.transportCode = transportCode;
  return details;
}

/** True when an upstream SDK/provider error says the model context was exceeded. */
export function isContextLengthExceededError(cause: unknown, formattedMessage = ''): boolean {
  // A frame carries a structured code, so trust it rather than the prose scan
  // below — which would also be scanning the frame's full serialized payload.
  const frame = frameFromError(cause)?.frame;
  if (frame) return frame.contextLengthExceeded;

  const details = sdkUpstreamErrorDetails(cause);
  // SAFETY: The object is read only through optional fields and each value is checked before use.
  const rec = cause && isObject(cause) ? cause as ApiCallLike : undefined;
  const candidates = [
    formattedMessage,
    details?.errorContent,
    rec?.message,
    rec?.responseBody,
    rec?.data?.error?.code,
    rec?.data?.error?.type,
    rec?.data?.error?.message,
    rec?.lastError?.message,
    ...(rec?.errors?.map(error => error.message) ?? []),
  ].filter((value): value is string => typeof value === 'string');
  return candidates.some(value => (
    /context_length_exceeded/i.test(value)
    || /context window/i.test(value)
    || /maximum context length/i.test(value)
    || /prompt is too long/i.test(value)
  ));
}

export function formatUpstreamError(cause: unknown): string {
  if (!cause || !isObject(cause)) return 'Upstream model request failed.';

  // SAFETY: The object guard above establishes the object carrier; optional fields are checked below.
  const rec = cause as ApiCallLike;

  // Stream error parts carry no top-level message, so they must be unwrapped
  // before the branches below fall through to the generic fallback.
  const frame = frameFromError(cause)?.frame;
  if (frame) {
    // Bound the least-trusted message source rather than dropping it; the full
    // payload is still recorded as errorContent for the diagnostic log.
    // sanitizeMessage keeps only the first line, which a leading newline makes
    // empty — an empty `message` field reads to Claude Code as no message at
    // all and it prints the raw error envelope instead.
    const short = truncateForClient(sanitizeMessage(frame.message)) || 'Upstream model request failed.';
    return `${short} (HTTP ${frame.statusCode})`;
  }

  if (rec.data?.error?.message) {
    const short = sanitizeMessage(rec.data.error.message);
    return rec.statusCode ? `${short} (HTTP ${rec.statusCode})` : short;
  }

  if (rec.responseBody) {
    try {
      const parsed: { error?: { message?: string } } = JSON.parse(rec.responseBody);
      if (parsed.error?.message) {
        const short = sanitizeMessage(parsed.error.message);
        return rec.statusCode ? `${short} (HTTP ${rec.statusCode})` : short;
      }
    } catch { /* ignore */ }
  }

  const last = rec.lastError;
  if (last?.message) {
    const code = last.statusCode;
    const short = sanitizeMessage(last.message);
    return code ? `${short} (HTTP ${code})` : short;
  }

  const fromList = rec.errors?.[rec.errors.length - 1];
  if (fromList?.message) {
    const short = sanitizeMessage(fromList.message);
    return fromList.statusCode ? `${short} (HTTP ${fromList.statusCode})` : short;
  }

  if (rec.message) {
    const short = sanitizeMessage(rec.message);
    if (short && !short.includes('file://') && !short.includes('APICallError') && short.length < 240) {
      return rec.statusCode ? `${short} (HTTP ${rec.statusCode})` : short;
    }
  }

  return 'Upstream model request failed.';
}

/** Real upstream HTTP status from an SDK error, falling back to sniffing the formatted message. */
export function upstreamHttpStatus(cause: unknown, message: string): number {
  if (cause && isObject(cause) && 'statusCode' in cause) {
    const code = cause.statusCode;
    if (isNumber(code) && code >= 400 && code <= 599) return code;
  }
  // A recognized frame always resolves to a status, so the recovered provider
  // message never reaches the prose sniffing below — where a digit in the
  // provider's own text would be misread as an HTTP status.
  const frameStatus = frameFromError(cause)?.frame.statusCode;
  if (frameStatus !== undefined) return frameStatus;
  if (message.includes('HTTP 429') || message.includes('429')) return 429;
  if (message.includes('HTTP 400')) return 400;
  return 500;
}

/** Anthropic SSE error `type` for a status code — lets clients tell retryable from terminal failures. */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 429: return 'rate_limit_error';
    case 504: return 'timeout_error';
    case 529: return 'overloaded_error';
    default: return 'api_error';
  }
}

/** HTTP failures Claude Code treats as transient when provider metadata was lost in a stream wrapper. */
export function isTransientUpstreamStatus(status: number): boolean {
  return status === 408
    || status === 409
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504
    || status === 529;
}

function truncateForClient(message: string): string {
  if (message.length <= MAX_CLIENT_MESSAGE_CHARS) return message;
  // Slice by code point: a UTF-16 slice can cut a surrogate pair in half and
  // emit a lone surrogate, which does not survive JSON serialization intact.
  return `${Array.from(message).slice(0, MAX_CLIENT_MESSAGE_CHARS - 1).join('')}…`;
}

function sanitizeMessage(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? message;
  if (line.startsWith('RetryError') || line.includes('AI_RetryError')) {
    return 'Upstream model request failed after retries.';
  }
  return line;
}
