import { createHash } from 'node:crypto';
import { isObject, isString } from '../../runtime/type-guards.js';
import { RESPONSES_LITE_HEADER } from './types.js';
import type { ResponsesWebSocketFetchOptions, JsonObject, JsonValue } from './types.js';

export interface HeaderRecord {
  [key: string]: string;
}

export interface PromptFieldHashes {
  [key: string]: string;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

export function toHeaderRecord(headers: HeadersInit | undefined): HeaderRecord {
  const out: HeaderRecord = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) out[key] = value;
  }
  return out;
}

export function hasResponsesLiteHeader(headers: HeaderRecord): boolean {
  return Object.entries(headers).some(
    ([key, value]) => key.toLowerCase() === RESPONSES_LITE_HEADER && value.toLowerCase() === 'true',
  );
}

export function authorizationHeaderFingerprint(headers: HeaderRecord): string {
  const authorization = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  return authorization ? createHash('sha256').update(authorization).digest('hex') : '';
}

export function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return '';
  if (isString(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body)).toString('utf8');
  return Object.prototype.toString.call(body);
}

export function applyResponsesLiteContract(payload: JsonObject): JsonObject {
  const reasoning = isJsonObject(payload.reasoning)
    ? { ...payload.reasoning }
    : {};
  reasoning.context = 'all_turns';
  return { ...payload, reasoning, store: false, parallel_tool_calls: false };
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isJsonObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).toSorted()) {
    const child = value[key];
    if (child !== undefined) out[key] = canonicalize(child);
  }
  return out;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

/** Fingerprint non-conversation request fields for privacy-safe diagnostics. */
export function responsesWebSocketPromptFingerprint(payload: JsonObject): string {
  const stable = { ...payload };
  delete stable.input;
  delete stable.previous_response_id;
  delete stable.stream;
  delete stable.background;
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}

export function responsesWebSocketPromptFieldHashes(payload: JsonObject): PromptFieldHashes {
  const hashes: PromptFieldHashes = {};
  for (const key of Object.keys(payload).toSorted()) {
    if (key === 'input' || key === 'previous_response_id' || key === 'stream' || key === 'background') continue;
    hashes[key] = createHash('sha256').update(canonicalJson(payload[key])).digest('hex').slice(0, 12);
  }
  return hashes;
}

export function changedPromptFields(
  previous: PromptFieldHashes | undefined,
  current: PromptFieldHashes,
): string[] {
  if (!previous) return [];
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter(key => previous[key] !== current[key])
    .toSorted();
}

export function instructionsFromPayload(payload: JsonObject): string | undefined {
  return isString(payload.instructions) ? payload.instructions : undefined;
}

export function instructionChangeSummary(previous: string | undefined, current: string | undefined): string | undefined {
  if (previous === undefined || current === undefined || previous === current) return undefined;
  const comparable = Math.min(previous.length, current.length);
  let prefix = 0;
  while (prefix < comparable && previous[prefix] === current[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < comparable - prefix
    && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) suffix += 1;
  const firstDiffLine = previous.slice(0, prefix).split('\n').length;
  return `instructions changed: previous_chars=${previous.length} current_chars=${current.length} common_prefix_chars=${prefix} common_suffix_chars=${suffix} first_diff_line=${firstDiffLine}`;
}

/**
 * Opaque socket partition key. Prompt fields intentionally are not part of this
 * key: Responses accepts fresh instructions/tools on each create, and Claude can
 * change them during a normal tool loop. Exact conversation lineage is validated
 * separately before previous_response_id is used. The authorization fingerprint
 * prevents a refreshed credential from inheriting a socket authenticated with the
 * token that the upstream rejected.
 */
export function responsesWebSocketPartitionKey(
  wsUrl: string,
  payload: JsonObject,
  options: Pick<ResponsesWebSocketFetchOptions, 'providerId' | 'accountId'> = {},
  authorizationFingerprint = '',
): string | undefined {
  const promptCacheKey = payload.prompt_cache_key;
  const model = payload.model;
  if (!isString(promptCacheKey) || !promptCacheKey || !isString(model) || !model) return undefined;
  const reasoning = isJsonObject(payload.reasoning)
    ? payload.reasoning
    : undefined;
  const effort = isString(reasoning?.effort) ? reasoning.effort.trim().toLowerCase() : '';
  const material = [
    wsUrl,
    options.providerId ?? 'openai',
    options.accountId ?? '',
    model,
    effort,
    promptCacheKey,
    authorizationFingerprint,
  ].join('\x1f');
  return createHash('sha256').update(material).digest('hex');
}

export function responsesCheckpointPartitionKey(
  wsUrl: string,
  payload: JsonObject,
  options: Pick<ResponsesWebSocketFetchOptions, 'providerId' | 'accountId'>,
  authorizationFingerprint: string,
): string | undefined {
  // OAuth access tokens rotate; compacted state belongs to the stable account,
  // model, effort, and Claude session cache key rather than one token. API-key
  // routes lack a stable account id and remain isolated by credential hash.
  return responsesWebSocketPartitionKey(
    wsUrl,
    payload,
    options,
    options.accountId ? '' : authorizationFingerprint,
  );
}

export function inputArray(payload: JsonObject): JsonValue[] {
  return Array.isArray(payload.input) ? payload.input : [];
}
