import { CODEX_RESPONSES_WEBSOCKETS_BETA } from '../../../constants.js';
import { isObject } from '../../../runtime/type-guards.js';
import type {
  JsonObject,
  JsonValue,
  ResponsesWebSocketFetchOptions,
} from '../types.js';
import {
  RESPONSES_WS_HARD_TTL_MS,
  RESPONSES_WS_IDLE_TTL_MS,
  RESPONSES_WS_MAX_CONNECTIONS,
  RESPONSES_WS_MAX_NURSERY_CONNECTIONS,
  RESPONSES_WS_NURSERY_IDLE_TTL_MS,
} from '../types.js';
import {
  applyResponsesLiteContract,
  authorizationHeaderFingerprint,
  bodyToString,
  hasResponsesLiteHeader,
  instructionsFromPayload,
  responsesCheckpointPartitionKey,
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFieldHashes,
  responsesWebSocketPromptFingerprint,
  toHeaderRecord,
} from '../fingerprint.js';
import type { HeaderRecord } from '../fingerprint.js';

function isJsonObject<Value>(value: Value): value is Value & JsonObject {
  return isObject(value) && !Array.isArray(value);
}

export function resolveWebSocketOptions(options: ResponsesWebSocketFetchOptions) {
  return {
    hardTtlMs: options.hardTtlMs ?? RESPONSES_WS_HARD_TTL_MS,
    idleTtlMs: options.idleTtlMs ?? RESPONSES_WS_IDLE_TTL_MS,
    nurseryIdleTtlMs: options.nurseryIdleTtlMs
      ?? Math.min(
        RESPONSES_WS_NURSERY_IDLE_TTL_MS,
        options.idleTtlMs ?? RESPONSES_WS_IDLE_TTL_MS,
      ),
    maxConnections: options.maxConnections ?? RESPONSES_WS_MAX_CONNECTIONS,
    maxNurseryConnections: options.maxNurseryConnections ?? RESPONSES_WS_MAX_NURSERY_CONNECTIONS,
    now: options.now ?? Date.now,
  };
}

export function checkpointStoreDirectory(
  options: ResponsesWebSocketFetchOptions,
): string | undefined {
  return options.compactThreshold === undefined
    ? undefined
    : options.checkpointStoreDir;
}

function hasNativeWebSearch(payload: JsonObject): boolean {
  return Array.isArray(payload.tools)
    && payload.tools.some(tool => (
      isJsonObject(tool) && tool.type === 'web_search'
    ));
}

function deleteHeader(headers: HeaderRecord, name: string): void {
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
  if (key) delete headers[key];
}

export function prepareResponsesRequest(
  wsUrl: string,
  init: RequestInit | undefined,
  options: ResponsesWebSocketFetchOptions,
) {
  const headers = toHeaderRecord(init?.headers);
  headers['OpenAI-Beta'] = CODEX_RESPONSES_WEBSOCKETS_BETA;

  let payload: JsonObject;
  try {
    const parsed: JsonValue = JSON.parse(bodyToString(init?.body));
    payload = isJsonObject(parsed) ? parsed : {};
  } catch {
    payload = {};
  }
  const bypassResponsesLite = hasResponsesLiteHeader(headers) && hasNativeWebSearch(payload);
  if (bypassResponsesLite) {
    // The ChatGPT Responses-Lite backend rejects hosted tools. The same model
    // accepts native web_search on the full Responses protocol over the same
    // WebSocket endpoint, so remove only the Lite negotiation headers for this
    // request. Keep it in a separate socket partition because upgrade headers
    // are connection-scoped.
    deleteHeader(headers, 'x-openai-internal-codex-responses-lite');
    deleteHeader(headers, 'version');
  } else if (hasResponsesLiteHeader(headers)) {
    payload = applyResponsesLiteContract(payload);
  }

  const authorizationFingerprint = authorizationHeaderFingerprint(headers);
  const partitionUrl = bypassResponsesLite ? `${wsUrl}#full-responses-web-search` : wsUrl;
  return {
    headers,
    payload,
    partitionKey: responsesWebSocketPartitionKey(
      partitionUrl,
      payload,
      options,
      authorizationFingerprint,
    ),
    checkpointKey: responsesCheckpointPartitionKey(
      partitionUrl,
      payload,
      options,
      authorizationFingerprint,
    ),
    promptFingerprint: responsesWebSocketPromptFingerprint(payload),
    promptFieldHashes: responsesWebSocketPromptFieldHashes(payload),
    instructionsSnapshot: instructionsFromPayload(payload),
  };
}
