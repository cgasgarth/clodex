import { createHash } from 'node:crypto';
import { TERMINAL_EVENT_TYPES } from './types.js';
import type { JsonObject, OutputAccumulator, RequestContext, ConnectionEntry } from './types.js';

export function eventType(event: unknown): string | undefined {
  return event && typeof event === 'object' && typeof (event as JsonObject).type === 'string'
    ? (event as JsonObject).type as string
    : undefined;
}

export function responseErrorCode(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  if (typeof record.code === 'string') return record.code;
  const error = record.error && typeof record.error === 'object' ? record.error as JsonObject : undefined;
  if (typeof error?.code === 'string') return error.code;
  const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
  const responseError = response?.error && typeof response.error === 'object' ? response.error as JsonObject : undefined;
  return typeof responseError?.code === 'string' ? responseError.code : undefined;
}

/**
 * Error CLASS of a frame, e.g. `usage_limit_reached`. Deliberately does not
 * fall back to the frame's own `type`: on an error chunk that is the chunk
 * discriminator (`'error'`), which names nothing.
 */
export function responseErrorType(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  const error = record.error && typeof record.error === 'object' ? record.error as JsonObject : undefined;
  if (typeof error?.type === 'string') return error.type;
  const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
  const responseError = response?.error && typeof response.error === 'object' ? response.error as JsonObject : undefined;
  return typeof responseError?.type === 'string' ? responseError.type : undefined;
}

export function responseRetryAfterSeconds(event: unknown): number | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
  const candidates = [record, record.error, response?.error];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const error = candidate as JsonObject;
    const value = error.retry_after_seconds ?? error.retry_after;
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

/**
 * HTTP status carried by an in-band error frame. The Codex backend reports it
 * as a top-level `status` (e.g. 400 alongside an `unsupported_parameter`
 * error); `response.status` is the response lifecycle state, not a status code,
 * so it is deliberately not consulted here.
 */
export function responseErrorStatus(event: unknown): number | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  for (const candidate of [record.status, (record.error as JsonObject | undefined)?.status]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)
      && candidate >= 400 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

export function responseErrorMessage(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object'
    ? record.response as JsonObject
    : undefined;
  for (const candidate of [record.error, response?.error, record]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const message = (candidate as JsonObject).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

export function responseIsContextLengthError(event: unknown): boolean {
  const code = responseErrorCode(event)?.toLowerCase() ?? '';
  const type = responseErrorType(event)?.toLowerCase() ?? '';
  const message = responseErrorMessage(event) ?? '';
  return /context_length|context_window/.test(`${code} ${type}`)
    || /context_length_exceeded|maximum context length|prompt is too long/i.test(message);
}

export function boundedDiagnosticIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && /^[a-zA-Z0-9_.:/-]+$/.test(normalized)
    ? normalized.slice(0, 128)
    : undefined;
}

export function diagnosticTextFingerprint(
  field: 'errorMessage' | 'closeReason',
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  return {
    [`${field}Bytes`]: Buffer.byteLength(value),
    [`${field}Hash`]: createHash('sha256').update(value).digest('hex').slice(0, 16),
  };
}

export function responseFailureDetails(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== 'object') return {};
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object'
    ? record.response as JsonObject
    : undefined;
  const error = record.error && typeof record.error === 'object'
    ? record.error as JsonObject
    : response?.error && typeof response.error === 'object'
      ? response.error as JsonObject
      : undefined;
  const incomplete = response?.incomplete_details && typeof response.incomplete_details === 'object'
    ? response.incomplete_details as JsonObject
    : undefined;
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof record.message === 'string' ? record.message : undefined;
  return {
    errorType: boundedDiagnosticIdentifier(error?.type ?? record.type),
    errorCode: boundedDiagnosticIdentifier(error?.code ?? record.code),
    responseStatus: boundedDiagnosticIdentifier(response?.status),
    incompleteReason: boundedDiagnosticIdentifier(incomplete?.reason),
    ...diagnosticTextFingerprint('errorMessage', message),
  };
}

export function emitContextDiagnostic(
  entry: ConnectionEntry,
  ctx: RequestContext,
  details: { event: string } & Record<string, unknown>,
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
  details: Record<string, unknown>,
): void {
  emitContextDiagnostic(entry, ctx, { event: 'ws_response_error', ...details });
}

function diagnosticItemIdHash(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? createHash('sha256').update(value).digest('hex').slice(0, 16)
    : undefined;
}

function reasoningPartIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function emitProtocolAnomaly(
  entry: ConnectionEntry,
  ctx: RequestContext,
  anomaly: string,
  itemId: unknown,
  summaryIndex: number | undefined,
  upstreamEventType: string,
): void {
  const itemIdHash = diagnosticItemIdHash(itemId);
  const key = `${anomaly}:${itemIdHash ?? 'none'}:${summaryIndex ?? 'none'}`;
  if (ctx.emittedProtocolAnomalies.has(key)) return;
  ctx.emittedProtocolAnomalies.add(key);
  const parts = typeof itemId === 'string' ? ctx.reasoningPartsByItemId.get(itemId) : undefined;
  emitContextDiagnostic(entry, ctx, {
    event: 'ws_response_protocol_anomaly',
    source: 'response_event_sequence',
    anomaly,
    upstreamEventType,
    itemIdHash,
    summaryIndex,
    knownSummaryParts: parts
      ? [...parts.entries()].sort(([left], [right]) => left - right)
        .map(([index, state]) => ({ summaryIndex: index, state }))
      : [],
    recentUpstreamEventTypes: [...ctx.recentUpstreamEventTypes],
  });
}

export function trackReasoningProtocol(
  entry: ConnectionEntry,
  ctx: RequestContext,
  event: unknown,
  type: string | undefined,
): void {
  if (!type || !event || typeof event !== 'object') return;
  ctx.recentUpstreamEventTypes.push(boundedDiagnosticIdentifier(type) ?? 'unknown');
  if (ctx.recentUpstreamEventTypes.length > 20) ctx.recentUpstreamEventTypes.shift();

  const record = event as JsonObject;
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : undefined;
    if (item?.type !== 'reasoning') return;
    const itemId = item.id;
    if (typeof itemId !== 'string' || itemId.length === 0) return;
    const current = ctx.reasoningPartsByItemId.get(itemId);
    if (type === 'response.output_item.added') {
      if (current) {
        emitProtocolAnomaly(entry, ctx, 'duplicate_reasoning_item_added', itemId, 0, type);
      }
      ctx.reasoningPartsByItemId.set(itemId, new Map([[0, 'active']]));
    } else {
      if (!current) {
        emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_item_done', itemId, undefined, type);
      }
      ctx.reasoningPartsByItemId.delete(itemId);
    }
    return;
  }

  if (!type.startsWith('response.reasoning_summary_')) {
    if (type === 'response.completed' && ctx.reasoningPartsByItemId.size > 0) {
      for (const itemId of ctx.reasoningPartsByItemId.keys()) {
        emitProtocolAnomaly(entry, ctx, 'reasoning_item_done_missing_before_completion', itemId, undefined, type);
      }
    }
    return;
  }

  const itemId = record.item_id;
  const summaryIndex = reasoningPartIndex(record.summary_index);
  if (typeof itemId !== 'string' || summaryIndex === undefined) return;
  const parts = ctx.reasoningPartsByItemId.get(itemId);
  const state = parts?.get(summaryIndex);

  if (type === 'response.reasoning_summary_part.added') {
    if (!parts) {
      emitProtocolAnomaly(entry, ctx, 'reasoning_item_missing_before_summary_part', itemId, summaryIndex, type);
      return;
    }
    if (summaryIndex > 0) {
      for (const [index, partState] of parts) {
        if (partState === 'can_conclude') parts.set(index, 'concluded');
      }
      if (state === 'active' || state === 'can_conclude') {
        emitProtocolAnomaly(entry, ctx, 'duplicate_reasoning_summary_part_added', itemId, summaryIndex, type);
      }
      parts.set(summaryIndex, 'active');
    }
    return;
  }

  if (type === 'response.reasoning_summary_text.delta') {
    if (state === undefined || state === 'concluded') {
      emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_delta', itemId, summaryIndex, type);
    }
    return;
  }

  if (type === 'response.reasoning_summary_part.done') {
    if (state === undefined || state === 'concluded') {
      emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_part_done', itemId, summaryIndex, type);
      return;
    }
    parts!.set(summaryIndex, ctx.originalPayload.store === true ? 'concluded' : 'can_conclude');
  }
}

function responseIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const response = (event as JsonObject).response;
  if (!response || typeof response !== 'object') return undefined;
  return typeof (response as JsonObject).id === 'string' ? (response as JsonObject).id as string : undefined;
}

export interface ResponseUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  serviceTier?: string;
}

export function responseUsage(event: unknown): ResponseUsage | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const response = (event as JsonObject).response;
  if (!response || typeof response !== 'object') return undefined;
  const usage = (response as JsonObject).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const usageRecord = usage as JsonObject;
  const serviceTier = typeof (response as JsonObject).service_tier === 'string'
    ? (response as JsonObject).service_tier as string
    : undefined;
  const details = usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object'
    ? usageRecord.input_tokens_details as JsonObject
    : {};
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return {
    inputTokens: number(usageRecord.input_tokens),
    cachedTokens: number(details.cached_tokens),
    cacheWriteTokens: number(details.cache_write_tokens ?? usageRecord.cache_write_tokens),
    outputTokens: number(usageRecord.output_tokens),
    ...(serviceTier ? { serviceTier } : {}),
  };
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

export function captureOutput(ctx: RequestContext, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const record = event as JsonObject;
  const type = eventType(event);
  if (type === 'response.created') {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    return;
  }
  if (type === 'response.output_item.added' && typeof record.output_index === 'number') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = typeof item.type === 'string' ? item.type : accumulator.type;
    accumulator.itemId = typeof item.id === 'string' ? item.id : accumulator.itemId;
    if (accumulator.itemId) ctx.outputIndexByItemId.set(accumulator.itemId, record.output_index);
    return;
  }
  if (type === 'response.output_text.delta' && typeof record.item_id === 'string') {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && typeof record.delta === 'string') outputAccumulator(ctx, index).text += record.delta;
    return;
  }
  if (type === 'response.reasoning_summary_text.delta' && typeof record.item_id === 'string') {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && typeof record.delta === 'string') {
      const accumulator = outputAccumulator(ctx, index);
      const summaryIndex = typeof record.summary_index === 'number' ? record.summary_index : 0;
      accumulator.summaries.set(summaryIndex, (accumulator.summaries.get(summaryIndex) ?? '') + record.delta);
    }
    return;
  }
  if (type === 'response.output_item.done' && typeof record.output_index === 'number') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = typeof item.type === 'string' ? item.type : accumulator.type;
    accumulator.done = item;
    return;
  }
  if (TERMINAL_EVENT_TYPES.has(type ?? '')) {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
    if (Array.isArray(response?.output) && ctx.outputByIndex.size === 0) {
      response.output.forEach((item, index) => {
        if (item && typeof item === 'object') {
          outputAccumulator(ctx, index).done = item as JsonObject;
          outputAccumulator(ctx, index).type = typeof (item as JsonObject).type === 'string'
            ? (item as JsonObject).type as string
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

export function expectedAssistantItems(ctx: RequestContext): unknown[] {
  const output: unknown[] = [];
  for (const [, accumulator] of [...ctx.outputByIndex.entries()].sort(([left], [right]) => left - right)) {
      const done = accumulator.done ?? {};
      const type = accumulator.type ?? (typeof done.type === 'string' ? done.type : undefined);
      if (type === 'message') {
        const doneContent = Array.isArray(done.content) ? done.content : undefined;
        const text = accumulator.text || (doneContent
          ? doneContent.filter(part => part && typeof part === 'object' && (part as JsonObject).type === 'output_text')
            .map(part => String((part as JsonObject).text ?? '')).join('')
          : '');
        output.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
        continue;
      }
      if (type === 'reasoning') {
        const summary = accumulator.summaries.size
          ? [...accumulator.summaries.entries()].sort(([a], [b]) => a - b)
            .map(([, text]) => ({ type: 'summary_text', text }))
          : Array.isArray(done.summary) ? done.summary : [];
        output.push({ ...withoutEphemeralFields(done), type: 'reasoning', summary });
        continue;
      }
      if (type === 'compaction' || type === 'compaction_summary') {
        output.push({ ...withoutEphemeralFields(done), type });
        continue;
      }
      if (type === 'function_call' || type === 'custom_tool_call') {
        output.push({ ...withoutEphemeralFields(done), type });
      }
  }
  return output;
}

export function encodeSse(ctx: RequestContext, event: unknown): void {
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
  try { ctx.controller.close(); } catch { /* already closed */ }
}
