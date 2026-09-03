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
import { rehomeOversizedResponsesInstructions } from './instructions.js';

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

function hasNativeWebSearch(payload: JsonObject): boolean {
  return Array.isArray(payload.tools)
    && payload.tools.some(tool => (
      isJsonObject(tool) && tool.type === 'web_search'
    ));
}

function hasParallelFunctionTools(payload: JsonObject): boolean {
  return payload.parallel_tool_calls === true
    && Array.isArray(payload.tools)
    && payload.tools.some(tool => (
      isJsonObject(tool) && tool.type === 'function'
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
  const hasLiteHeader = hasResponsesLiteHeader(headers);
  const bypassForWebSearch = hasLiteHeader && hasNativeWebSearch(payload);
  const bypassForParallelTools = hasLiteHeader && hasParallelFunctionTools(payload);
  const bypassResponsesLite = bypassForWebSearch || bypassForParallelTools;
  if (bypassResponsesLite) {
    // Responses Lite rejects hosted tools and parallel function calls. The same
    // model can use both features on the full Responses protocol over this
    // endpoint. Remove only the Lite negotiation headers and keep the request
    // in a separate socket partition because upgrade headers are connection-scoped.
    deleteHeader(headers, 'x-openai-internal-codex-responses-lite');
    deleteHeader(headers, 'version');
  } else if (hasLiteHeader) {
    payload = applyResponsesLiteContract(payload);
  }

  // Preserve prompt diagnostics from Claude's original instruction string.
  // The provider-facing payload can move an oversized value into input items,
  // but instruction changes must remain visible to head selection diagnostics.
  const promptFingerprint = responsesWebSocketPromptFingerprint(payload);
  const promptFieldHashes = responsesWebSocketPromptFieldHashes(payload);
  const instructionsSnapshot = instructionsFromPayload(payload);
  const rehomedInstructions = rehomeOversizedResponsesInstructions(payload);
  payload = rehomedInstructions.payload;

  const authorizationFingerprint = authorizationHeaderFingerprint(headers);
  const partitionUrl = bypassForWebSearch
    ? `${wsUrl}#full-responses-web-search`
    : bypassForParallelTools
      ? `${wsUrl}#full-responses-parallel-tools`
      : wsUrl;
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
    promptFingerprint,
    promptFieldHashes,
    instructionsSnapshot,
    rehomedInstructions: rehomedInstructions.metadata,
  };
}
