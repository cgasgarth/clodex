import { createHash } from 'node:crypto';
import { isNumber, isObject, isString } from '../../runtime/type-guards.js';
import { sanitizeToolInput } from '../../tool-input-sanitize.js';
import type { ProviderDataValue } from '../../types.js';
import { TERMINAL_EVENT_TYPES } from './types.js';
import type {
  JsonObject,
  JsonValue,
  OutputAccumulator,
  RequestContext,
  ConnectionEntry,
} from './types.js';

function isJsonObject<Value>(value: Value): value is Value & JsonObject {
  return isObject(value) && !Array.isArray(value);
}

export function eventType(event: JsonValue): string | undefined {
  return isJsonObject(event) && isString(event.type) ? event.type : undefined;
}

export function responseErrorCode(event: JsonValue): string | undefined {
  if (!isJsonObject(event)) return undefined;
  if (isString(event.code)) return event.code;
  const error = isJsonObject(event.error) ? event.error : undefined;
  if (isString(error?.code)) return error.code;
  const response = isJsonObject(event.response) ? event.response : undefined;
  const responseError = isJsonObject(response?.error) ? response.error : undefined;
  return isString(responseError?.code) ? responseError.code : undefined;
}

/**
 * Error CLASS of a frame, e.g. `usage_limit_reached`. Deliberately does not
 * fall back to the frame's own `type`: on an error chunk that is the chunk
 * discriminator (`'error'`), which names nothing.
 */
export function responseErrorType(event: JsonValue): string | undefined {
  if (!isJsonObject(event)) return undefined;
  const error = isJsonObject(event.error) ? event.error : undefined;
  if (isString(error?.type)) return error.type;
  const response = isJsonObject(event.response) ? event.response : undefined;
  const responseError = isJsonObject(response?.error) ? response.error : undefined;
  return isString(responseError?.type) ? responseError.type : undefined;
}

export function responseRetryAfterSeconds(event: JsonValue): number | undefined {
  if (!isJsonObject(event)) return undefined;
  const response = isJsonObject(event.response) ? event.response : undefined;
  const candidates = [event, event.error, response?.error];
  for (const candidate of candidates) {
    if (!isJsonObject(candidate)) continue;
    const error = candidate;
    const value = error.retry_after_seconds ?? error.retry_after;
    if (isNumber(value)) return value;
    if (isString(value) && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

/**
 * HTTP status carried by an in-band error frame. The Codex backend reports it
 * as a top-level `status` (e.g. 400 alongside an `unsupported_parameter`
 * error); `response.status` is the response lifecycle state, not a status code,
 * so it is deliberately not consulted here.
 */
export function responseErrorStatus(event: JsonValue): number | undefined {
  if (!isJsonObject(event)) return undefined;
  const error = isJsonObject(event.error) ? event.error : undefined;
  for (const candidate of [event.status, error?.status]) {
    if (isNumber(candidate) && Number.isInteger(candidate)
      && candidate >= 400 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

export function responseErrorMessage(event: JsonValue): string | undefined {
  if (!isJsonObject(event)) return undefined;
  const response = isJsonObject(event.response) ? event.response : undefined;
  for (const candidate of [event.error, response?.error, event]) {
    if (!isJsonObject(candidate)) continue;
    const message = candidate.message;
    if (isString(message) && message.trim()) return message.trim();
  }
  return undefined;
}

export function responseIsContextLengthError(event: JsonValue): boolean {
  const code = responseErrorCode(event)?.toLowerCase() ?? '';
  const type = responseErrorType(event)?.toLowerCase() ?? '';
  const message = responseErrorMessage(event) ?? '';
  return /context_length|context_window/.test(`${code} ${type}`)
    || /context_length_exceeded|maximum context length|prompt is too long/i.test(message);
}

export function boundedDiagnosticIdentifier(value: JsonValue): string | undefined {
  if (!isString(value)) return undefined;
  const normalized = value.trim();
  return normalized && /^[a-zA-Z0-9_.:/-]+$/.test(normalized)
    ? normalized.slice(0, 128)
    : undefined;
}

export function diagnosticTextFingerprint(
  field: 'errorMessage' | 'closeReason',
  value: JsonValue,
): JsonObject {
  if (!isString(value) || value.length === 0) return {};
  return {
    [`${field}Bytes`]: Buffer.byteLength(value),
    [`${field}Hash`]: createHash('sha256').update(value).digest('hex').slice(0, 16),
  };
}

export function responseFailureDetails(event: JsonValue): JsonObject {
  if (!isJsonObject(event)) return {};
  const response = isJsonObject(event.response) ? event.response : undefined;
  const error = isJsonObject(event.error)
    ? event.error
    : isJsonObject(response?.error) ? response.error : undefined;
  const incomplete = isJsonObject(response?.incomplete_details)
    ? response.incomplete_details
    : undefined;
  const message = isString(error?.message)
    ? error.message
    : isString(event.message) ? event.message : undefined;
  return {
    errorType: boundedDiagnosticIdentifier(error?.type ?? event.type),
    errorCode: boundedDiagnosticIdentifier(error?.code ?? event.code),
    responseStatus: boundedDiagnosticIdentifier(response?.status),
    incompleteReason: boundedDiagnosticIdentifier(incomplete?.reason),
    ...diagnosticTextFingerprint('errorMessage', message),
  };
}

export function emitContextDiagnostic(
  entry: ConnectionEntry,
  ctx: RequestContext,
  details: { event: string } & JsonObject,
): void {
  ctx.emitDiagnostic?.({
    connectionId: entry.debugId,
    generation: entry.generation,
    continued: ctx.continued,
    retried: ctx.retried,
    frameCount: ctx.frameCount,
    emittedModelData: ctx.emittedModelData,
    responseIdReceived: Boolean(ctx.responseId),
    inFlightMs: entry.inFlightStartedAt === undefined
      ? undefined
      : Math.max(0, entry.options.now() - entry.inFlightStartedAt),
    ...details,
  });
}

export function emitResponseErrorDiagnostic(
  entry: ConnectionEntry,
  ctx: RequestContext,
  details: JsonObject,
): void {
  emitContextDiagnostic(entry, ctx, { event: 'ws_response_error', ...details });
}

function responseIdFromEvent(event: JsonValue): string | undefined {
  if (!isJsonObject(event) || !isJsonObject(event.response)) return undefined;
  return isString(event.response.id) ? event.response.id : undefined;
}

export interface ResponseUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  serviceTier?: string;
}

function finiteNumber(value: JsonValue): number {
  return isNumber(value) && Number.isFinite(value) ? value : 0;
}

export function responseUsage(event: JsonValue): ResponseUsage | undefined {
  if (!isJsonObject(event) || !isJsonObject(event.response)) return undefined;
  const response = event.response;
  if (!isJsonObject(response.usage)) return undefined;
  const usageRecord = response.usage;
  const serviceTier = isString(response.service_tier)
    ? response.service_tier
    : undefined;
  const details = isJsonObject(usageRecord.input_tokens_details)
    ? usageRecord.input_tokens_details
    : {};
  const result: ResponseUsage = {
    inputTokens: finiteNumber(usageRecord.input_tokens),
    cachedTokens: finiteNumber(details.cached_tokens),
    cacheWriteTokens: finiteNumber(details.cache_write_tokens ?? usageRecord.cache_write_tokens),
    outputTokens: finiteNumber(usageRecord.output_tokens),
  };
  if (serviceTier) result.serviceTier = serviceTier;
  return result;
}

export function responseUsageDebug(usage: ResponseUsage): string {
  return `usage input_tokens=${usage.inputTokens} `
    + `cached_tokens=${usage.cachedTokens} `
    + `cache_write_tokens=${usage.cacheWriteTokens} `
    + `output_tokens=${usage.outputTokens}`
    + (usage.serviceTier ? ` service_tier=${usage.serviceTier}` : '');
}

function outputAccumulator(ctx: RequestContext, index: number): OutputAccumulator {
  let accumulator = ctx.outputByIndex.get(index);
  if (!accumulator) {
    accumulator = { text: '', summaries: new Map() };
    ctx.outputByIndex.set(index, accumulator);
  }
  return accumulator;
}

export function captureOutput(ctx: RequestContext, event: JsonValue): void {
  if (!isJsonObject(event)) return;
  const record = event;
  const type = eventType(event);
  if (type === 'response.created') {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    return;
  }
  if (type === 'response.output_item.added' && isNumber(record.output_index)) {
    const item = isJsonObject(record.item) ? record.item : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = isString(item.type) ? item.type : accumulator.type;
    accumulator.itemId = isString(item.id) ? item.id : accumulator.itemId;
    if (accumulator.itemId) ctx.outputIndexByItemId.set(accumulator.itemId, record.output_index);
    return;
  }
  if (type === 'response.output_text.delta' && isString(record.item_id)) {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && isString(record.delta)) outputAccumulator(ctx, index).text += record.delta;
    return;
  }
  if (type === 'response.reasoning_summary_text.delta' && isString(record.item_id)) {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && isString(record.delta)) {
      const accumulator = outputAccumulator(ctx, index);
      const summaryIndex = isNumber(record.summary_index) ? record.summary_index : 0;
      accumulator.summaries.set(summaryIndex, (accumulator.summaries.get(summaryIndex) ?? '') + record.delta);
    }
    return;
  }
  if (type === 'response.output_item.done' && isNumber(record.output_index)) {
    const item = isJsonObject(record.item) ? record.item : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = isString(item.type) ? item.type : accumulator.type;
    accumulator.done = item;
    return;
  }
  if (TERMINAL_EVENT_TYPES.has(type ?? '')) {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    const response = isJsonObject(record.response) ? record.response : undefined;
    if (Array.isArray(response?.output) && ctx.outputByIndex.size === 0) {
      response.output.forEach((item, index) => {
        if (isJsonObject(item)) {
          outputAccumulator(ctx, index).done = item;
          outputAccumulator(ctx, index).type = isString(item.type)
            ? item.type
            : undefined;
        }
      });
    }
  }
}

function withoutEphemeralFields(item: JsonObject): JsonObject {
  const out = { ...item };
  delete out.id;
  delete out.status;
  delete out.phase;
  delete out.role;
  for (const [key, value] of Object.entries(out)) {
    if (value == null) delete out[key];
  }
  return out;
}

/** Read the required properties from each function tool in the request. */
function requiredToolProps(payload: JsonObject): Map<string, ReadonlySet<string>> {
  const output = new Map<string, ReadonlySet<string>>();
  const add = (value: JsonValue): void => {
    if (!isJsonObject(value)) return;
    if (value.type === 'namespace' && Array.isArray(value.tools)) {
      for (const nested of value.tools) add(nested);
      return;
    }
    if (value.type !== 'function' || !isString(value.name)) return;
    const parameters = isJsonObject(value.parameters) ? value.parameters : undefined;
    const required = Array.isArray(parameters?.required) ? parameters.required : [];
    output.set(value.name, new Set(required.filter(isString)));
  };
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) add(tool);
  }
  return output;
}

/**
 * Store function arguments in the same shape that the Anthropic translation
 * sends to Claude Code. The upstream request itself stays unchanged.
 */
function sanitizedCallArguments(
  item: JsonObject,
  requiredProps: Map<string, ReadonlySet<string>>,
): JsonObject {
  if (!isString(item.arguments)) return item;
  const raw = item.arguments.trim();
  let parsed: unknown;
  try {
    parsed = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return item;
  }
  if (!isJsonObject(parsed)) return item;
  const required = requiredProps.get(isString(item.name) ? item.name : '');
  // SAFETY: JSON.parse produced this object, so each property is JSON data.
  const toolInput = parsed as Record<string, ProviderDataValue>;
  return {
    ...item,
    arguments: JSON.stringify(sanitizeToolInput(toolInput, required)),
  };
}

export function expectedAssistantItems(ctx: RequestContext): JsonValue[] {
  const output: JsonValue[] = [];
  const requiredProps = requiredToolProps(ctx.originalPayload);
  for (const [, accumulator] of [...ctx.outputByIndex.entries()].toSorted(([left], [right]) => left - right)) {
      const done = accumulator.done ?? {};
      const type = accumulator.type ?? (isString(done.type) ? done.type : undefined);
      if (type === 'message') {
        const doneContent = Array.isArray(done.content) ? done.content : undefined;
        const text = accumulator.text || (doneContent
          ? doneContent.filter(part => isJsonObject(part) && part.type === 'output_text')
            .map(part => isJsonObject(part) && isString(part.text) ? part.text : '').join('')
          : '');
        output.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
        continue;
      }
      if (type === 'reasoning') {
        const summary = accumulator.summaries.size
          ? [...accumulator.summaries.entries()].toSorted(([a], [b]) => a - b)
            .map(([, text]) => ({ type: 'summary_text', text }))
          : Array.isArray(done.summary) ? done.summary : [];
        output.push({ ...withoutEphemeralFields(done), type: 'reasoning', summary });
        continue;
      }
      if (type === 'compaction' || type === 'compaction_summary') {
        output.push({ ...withoutEphemeralFields(done), type });
        continue;
      }
      if (type === 'function_call') {
        output.push({
          ...sanitizedCallArguments(withoutEphemeralFields(done), requiredProps),
          type,
        });
        continue;
      }
      if (type === 'custom_tool_call') {
        output.push({ ...withoutEphemeralFields(done), type });
      }
  }
  return output;
}

export function encodeSse(ctx: RequestContext, event: JsonValue): void {
  if (ctx.closed) return;
  ctx.controller.enqueue(ctx.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

export function flushPending(ctx: RequestContext): void {
  for (const event of ctx.pendingEvents) encodeSse(ctx, event);
  ctx.pendingEvents = [];
}

export function closeContext(ctx: RequestContext): void {
  if (ctx.closed) return;
  ctx.closed = true;
  ctx.abortCleanup?.();
  ctx.resolveSettled?.();
  ctx.resolveSettled = undefined;
  try { ctx.controller.close(); } catch { /* already closed */ }
}
