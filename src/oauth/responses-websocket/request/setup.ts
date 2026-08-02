import { CODEX_RESPONSES_WEBSOCKETS_BETA } from '../../../constants.js';
import type {
  JsonObject,
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
  applyResponsesLiteShape,
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

export function prepareResponsesRequest(
  wsUrl: string,
  init: RequestInit | undefined,
  options: ResponsesWebSocketFetchOptions,
) {
  const headers = toHeaderRecord(init?.headers);
  headers['OpenAI-Beta'] = CODEX_RESPONSES_WEBSOCKETS_BETA;

  let payload: JsonObject;
  try {
    payload = JSON.parse(bodyToString(init?.body)) as JsonObject;
  } catch {
    payload = {};
  }
  if (hasResponsesLiteHeader(headers)) payload = applyResponsesLiteShape(payload);

  const authorizationFingerprint = authorizationHeaderFingerprint(headers);
  return {
    headers,
    payload,
    partitionKey: responsesWebSocketPartitionKey(
      wsUrl,
      payload,
      options,
      authorizationFingerprint,
    ),
    checkpointKey: responsesCheckpointPartitionKey(
      wsUrl,
      payload,
      options,
      authorizationFingerprint,
    ),
    promptFingerprint: responsesWebSocketPromptFingerprint(payload),
    promptFieldHashes: responsesWebSocketPromptFieldHashes(payload),
    instructionsSnapshot: instructionsFromPayload(payload),
  };
}
