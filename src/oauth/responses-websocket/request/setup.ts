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
  authorizationHeaderFingerprint,
  bodyToString,
  instructionsFromPayload,
  responsesCheckpointPartitionKey,
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFieldHashes,
  responsesWebSocketPromptFingerprint,
  toHeaderRecord,
} from '../fingerprint.js';
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
  payload.store = false;
  for (const field of ['stream', 'background', 'conversation', 'max_output_tokens', 'max_tool_calls',
    'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention',
    'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user']) {
    delete payload[field];
  }
  if (Array.isArray(payload.tools)) {
    const localTools = payload.tools.filter(tool => isJsonObject(tool) && (tool.type === 'function' || tool.type === 'custom'));
    if (localTools.length) {
      payload.tools = [
        ...payload.tools.filter(tool => !localTools.includes(tool)),
        { type: 'namespace', name: 'clodex', description: 'Tools executed by the Clodex client', tools: localTools },
      ];
      if (isJsonObject(payload.tool_choice) && payload.tool_choice.type === 'function') {
        payload.tool_choice.namespace = 'clodex';
      }
    }
  }
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (isJsonObject(item) && item.role === 'system') item.role = 'developer';
    }
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
    promptFingerprint,
    promptFieldHashes,
    instructionsSnapshot,
    rehomedInstructions: rehomedInstructions.metadata,
  };
}
