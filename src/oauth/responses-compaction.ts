import { createHash } from 'node:crypto';
import { NATIVE_COMPACTION_TIMEOUT_MS } from '../timeouts.js';

type JsonObject = Record<string, unknown>;

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'enabled']);
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

export const OPENAI_COMPACTION_DEFAULT_RATIO = 0.9;
// Native compaction on a large context can legitimately take several minutes.
// Prefer preserving the thread over failing a healthy but slow compaction.
export const RESPONSES_COMPACT_TIMEOUT_MS = NATIVE_COMPACTION_TIMEOUT_MS;

export interface ResponsesCompactionUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface ResponsesCompactionResult {
  output: unknown[];
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
 * Resolve the native-compaction threshold. The default mirrors Codex:
 * compact at 90% of the model's advertised context window.
 *
 * Native compaction is experimental and off by default. Set
 * CLODEX_OPENAI_COMPACTION=1 to opt in.
 */
export function resolveOpenAiCompactionThreshold(
  contextWindow: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const configured = env.CLODEX_OPENAI_COMPACTION?.trim().toLowerCase();
  if (!configured || !ENABLED_VALUES.has(configured)) return undefined;

  const modelSafeThreshold = Number.isFinite(contextWindow) && (contextWindow ?? 0) > 0
    ? Math.floor(contextWindow! * OPENAI_COMPACTION_DEFAULT_RATIO)
    : undefined;
  const explicit = env.CLODEX_OPENAI_COMPACT_THRESHOLD?.trim();
  if (explicit) {
    const parsed = Number(explicit);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return modelSafeThreshold === undefined
        ? parsed
        : Math.min(parsed, modelSafeThreshold);
    }
  }

  return modelSafeThreshold;
}

export function responsesCompactUrl(input: string | URL | Request): string {
  const raw = typeof input === 'string'
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

function usageFromResponse(value: unknown): ResponsesCompactionUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as JsonObject;
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as JsonObject
    : {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    cachedTokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : 0,
    cacheWriteTokens: typeof details.cache_write_tokens === 'number' ? details.cache_write_tokens : 0,
    outputTokens: outputTokens ?? 0,
  };
}

function responseErrorFingerprint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as JsonObject;
  const error = record.error && typeof record.error === 'object'
    ? record.error as JsonObject
    : record;
  const message = typeof error.message === 'string' ? error.message : undefined;
  return message
    ? createHash('sha256').update(message).digest('hex').slice(0, 16)
    : undefined;
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)
    ? value
    : undefined;
}

function compactFailureDetails(
  value: unknown,
  statusCode: number,
): {
  failureClass: ResponsesCompactionFailureClass;
  errorCode?: string;
  errorType?: string;
  errorFingerprint?: string;
} {
  const root = value && typeof value === 'object' ? value as JsonObject : {};
  const error = root.error && typeof root.error === 'object'
    ? root.error as JsonObject
    : root;
  const errorCode = boundedIdentifier(error.code);
  const errorType = boundedIdentifier(error.type);
  const message = typeof error.message === 'string' ? error.message : '';
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
    let body: unknown;
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
        usageFromResponse((body as JsonObject).usage),
        details,
      );
    }
    if (!body || typeof body !== 'object' || !Array.isArray((body as JsonObject).output)) {
      throw new ResponsesCompactionError('OpenAI compact endpoint omitted its canonical output');
    }
    return {
      output: (body as JsonObject).output as unknown[],
      usage: usageFromResponse((body as JsonObject).usage),
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
