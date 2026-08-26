import { createHash } from 'node:crypto';
import { NATIVE_COMPACTION_TIMEOUT_MS } from '../config/timeouts.js';
import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import type { JsonObject, JsonValue } from './responses-websocket/types.js';

function isJsonObject(value: JsonValue): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

const COMPACT_BODY_FIELDS = [
  'model',
  'input',
  'instructions',
  'tools',
  'parallel_tool_calls',
  'reasoning',
  'service_tier',
  'prompt_cache_key',
  'text',
] as const;

export const OPENAI_COMPACTION_DEFAULT_THRESHOLD = 350_000;
export const OPENAI_COMPACTION_MAX_CONTEXT_RATIO = 0.9;
const OPENAI_COMPACTION_REARM_CONTEXT_RATIO = 0.05;
const OPENAI_COMPACTION_REARM_MIN_TOKENS = 16_000;
// Native compaction on a large context can legitimately take several minutes.
// Prefer preserving the thread over failing a healthy but slow compaction.
export const RESPONSES_COMPACT_TIMEOUT_MS = NATIVE_COMPACTION_TIMEOUT_MS;

let nativeCompactionEnabled = true;

function isNativeCompactionEnabled(): boolean {
  return nativeCompactionEnabled;
}

export function setNativeCompactionEnabled(enabled: boolean): void {
  nativeCompactionEnabled = enabled;
}

export interface ResponsesCompactionUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface ResponsesCompactionResult {
  output: JsonValue[];
  usage?: ResponsesCompactionUsage;
}

export interface CompactResponsesWindowOptions {
  requestUrl: string | URL | Request;
  headers: HeadersInit | undefined;
  payload: JsonObject;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ResponsesCompactionFailureClass =
  | 'context_length'
  | 'auth'
  | 'rate_limit_or_capacity'
  | 'timeout_or_transport'
  | 'other_4xx'
  | 'server'
  | 'invalid_response';

export class ResponsesCompactionError extends Error {
  readonly statusCode?: number;
  readonly usage?: ResponsesCompactionUsage;
  readonly failureClass: ResponsesCompactionFailureClass;
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly errorFingerprint?: string;

  constructor(
    message: string,
    statusCode?: number,
    usage?: ResponsesCompactionUsage,
    details: {
      failureClass?: ResponsesCompactionFailureClass;
      errorCode?: string;
      errorType?: string;
      errorFingerprint?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ResponsesCompactionError';
    this.statusCode = statusCode;
    this.usage = usage;
    this.failureClass = details.failureClass ?? (
      statusCode !== undefined && statusCode >= 500
        ? 'server'
        : statusCode !== undefined && statusCode >= 400
          ? 'other_4xx'
          : 'invalid_response'
    );
    this.errorCode = details.errorCode;
    this.errorType = details.errorType;
    this.errorFingerprint = details.errorFingerprint;
  }
}

/**
 * Resolve the native-compaction threshold. Enabled GPT models compact at
 * 350K input tokens, capped at 90% of smaller advertised context windows.
 */
export function resolveOpenAiCompactionThreshold(
  contextWindow: number | undefined,
  enabled = isNativeCompactionEnabled(),
): number | undefined {
  if (!enabled) return undefined;

  const usableContextWindow = isNumber(contextWindow)
    && Number.isFinite(contextWindow)
    && contextWindow > 0
    ? contextWindow
    : undefined;
  const modelSafeThreshold = usableContextWindow === undefined
    ? undefined
    : Math.floor(usableContextWindow * OPENAI_COMPACTION_MAX_CONTEXT_RATIO);
  return modelSafeThreshold === undefined
    ? undefined
    : Math.min(OPENAI_COMPACTION_DEFAULT_THRESHOLD, modelSafeThreshold);
}

/**
 * Prevent a compacted response whose opaque state remains near the configured
 * threshold from immediately starting another compaction. The hard context
 * limit remains the final overflow boundary.
 */
export function resolveOpenAiCompactionRearmThreshold(
  configuredThreshold: number,
  postCompactionInputTokens: number,
  contextWindow: number | undefined,
): number {
  const usableContextWindow = isNumber(contextWindow)
    && Number.isFinite(contextWindow)
    && contextWindow > 0
    ? contextWindow
    : undefined;
  const growth = usableContextWindow !== undefined
    ? Math.max(
        OPENAI_COMPACTION_REARM_MIN_TOKENS,
        Math.floor(usableContextWindow * OPENAI_COMPACTION_REARM_CONTEXT_RATIO),
      )
    : OPENAI_COMPACTION_REARM_MIN_TOKENS;
  const candidate = Math.max(
    configuredThreshold,
    postCompactionInputTokens + growth,
  );
  return usableContextWindow !== undefined
    ? Math.min(candidate, Math.max(configuredThreshold, Math.floor(usableContextWindow) - 1))
    : candidate;
}

export function responsesCompactUrl(input: string | URL | Request): string {
  const raw = isString(input)
    ? input
    : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw);
  const normalized = url.pathname.replace(/\/+$/, '');
  url.pathname = normalized.endsWith('/responses/compact')
    ? normalized
    : normalized.endsWith('/responses')
      ? `${normalized}/compact`
      : `${normalized}/responses/compact`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Match the request shape used by Codex's own standalone compact client. */
export function compactRequestPayload(payload: JsonObject): JsonObject {
  const compact: JsonObject = {};
  for (const key of COMPACT_BODY_FIELDS) {
    if (payload[key] !== undefined) compact[key] = payload[key];
  }
  return compact;
}

function compactHeaders(input: HeadersInit | undefined): Headers {
  const headers = new Headers(input);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  headers.delete('content-length');

  // The HTTP compact call is not a Responses WebSocket upgrade. Preserve other
  // beta feature values if they coexist with the WebSocket transport marker.
  const beta = headers.get('OpenAI-Beta');
  if (beta) {
    const retained = beta.split(',')
      .map(value => value.trim())
      .filter(value => value && !value.startsWith('responses_websockets='));
    if (retained.length) headers.set('OpenAI-Beta', retained.join(', '));
    else headers.delete('OpenAI-Beta');
  }
  return headers;
}

function usageFromResponse(value: JsonValue): ResponsesCompactionUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const usage = value;
  const details = isJsonObject(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};
  const inputTokens = isNumber(usage.input_tokens) ? usage.input_tokens : undefined;
  const outputTokens = isNumber(usage.output_tokens) ? usage.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    cachedTokens: isNumber(details.cached_tokens) ? details.cached_tokens : 0,
    cacheWriteTokens: isNumber(details.cache_write_tokens) ? details.cache_write_tokens : 0,
    outputTokens: outputTokens ?? 0,
  };
}

function responseErrorFingerprint(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const error = isJsonObject(value.error) ? value.error : value;
  const message = isString(error.message) ? error.message : undefined;
  return message
    ? createHash('sha256').update(message).digest('hex').slice(0, 16)
    : undefined;
}

function boundedIdentifier(value: JsonValue): string | undefined {
  return isString(value) && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)
    ? value
    : undefined;
}

interface CompactFailureDetails {
  failureClass: ResponsesCompactionFailureClass;
  errorCode?: string;
  errorType?: string;
  errorFingerprint?: string;
}

function compactFailureDetails(
  value: JsonValue,
  statusCode: number,
): CompactFailureDetails {
  const root = isJsonObject(value) ? value : {};
  const error = isJsonObject(root.error) ? root.error : root;
  const errorCode = boundedIdentifier(error.code);
  const errorType = boundedIdentifier(error.type);
  const message = isString(error.message) ? error.message : '';
  const discriminator = `${errorCode ?? ''} ${errorType ?? ''}`.toLowerCase();
  const failureClass: ResponsesCompactionFailureClass =
    /context_length|context_window/.test(discriminator)
      || /context_length_exceeded|maximum context length|prompt is too long/i.test(message)
      ? 'context_length'
      : statusCode === 401 || statusCode === 403
        ? 'auth'
        : statusCode === 408 || statusCode === 409 || statusCode === 429
          || /rate_limit|capacity|overload/.test(discriminator)
          ? 'rate_limit_or_capacity'
          : statusCode >= 500
            ? 'server'
            : 'other_4xx';
  return {
    failureClass,
    errorCode,
    errorType,
    errorFingerprint: responseErrorFingerprint(value),
  };
}

/**
 * Call the stateless `/responses/compact` endpoint. The returned output is
 * canonical and must be forwarded as-is to the next Responses create call.
 */
export async function compactResponsesWindow(
  options: CompactResponsesWindowOptions,
): Promise<ResponsesCompactionResult> {
  const requestFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RESPONSES_COMPACT_TIMEOUT_MS;
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`OpenAI compaction exceeded ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );

  try {
    const response = await requestFetch(responsesCompactUrl(options.requestUrl), {
      method: 'POST',
      headers: compactHeaders(options.headers),
      body: JSON.stringify(compactRequestPayload(options.payload)),
      signal: controller.signal,
    });
    let body: JsonValue;
    try {
      body = await response.json();
    } catch {
      throw new ResponsesCompactionError(
        `OpenAI compact endpoint returned invalid JSON (HTTP ${response.status})`,
        response.status,
        undefined,
        { failureClass: 'invalid_response' },
      );
    }
    if (!response.ok) {
      const details = compactFailureDetails(body, response.status);
      throw new ResponsesCompactionError(
        `OpenAI compact endpoint failed (HTTP ${response.status}`
          + `${details.errorFingerprint ? `, error ${details.errorFingerprint}` : ''})`,
        response.status,
        usageFromResponse(isJsonObject(body) ? body.usage : undefined),
        details,
      );
    }
    if (!isJsonObject(body) || !Array.isArray(body.output)) {
      throw new ResponsesCompactionError('OpenAI compact endpoint omitted its canonical output');
    }
    return {
      output: body.output,
      usage: usageFromResponse(body.usage),
    };
  } catch (error) {
    if (error instanceof ResponsesCompactionError) throw error;
    const timedOut = controller.signal.aborted;
    throw new ResponsesCompactionError(
      timedOut
        ? `OpenAI compaction exceeded ${Math.round(timeoutMs / 1000)}s`
        : 'OpenAI compact transport failed',
      undefined,
      undefined,
      { failureClass: 'timeout_or_transport' },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
