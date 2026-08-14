import { randomUUID } from 'node:crypto';
import { anthropicErrorType, clampRetryAfterSeconds } from '../../upstream-error.js';
import { deleteStoredResponsesCheckpoint } from '../responses-checkpoint-store.js';
import {
  TERMINAL_EVENT_TYPES,
  FAILURE_EVENT_TYPES,
  RESPONSES_WS_WARM_NURSERY_CONNECTIONS_PER_PARTITION,
} from './types.js';
import type {
  JsonObject,
  RawData,
  ResponsesWebSocket,
  RequestContext,
  ConnectionEntry,
} from './types.js';
import {
  compactionCheckpoints,
  allocateConnectionDebugId,
  allocateLineageDebugId,
  connectionEntries,
  connectionCountByGeneration,
  saveCompactionCheckpoint,
  registerEntry,
  unregisterEntry,
  debugKey,
} from './state.js';
import { changedPromptFields, inputArray } from './fingerprint.js';
import {
  assistantCompactionSummaryText,
  compactionSummaryHash,
  conversationItemHash,
  conversationItemKind,
} from './continuation.js';
import {
  eventType,
  responseErrorCode,
  responseErrorType,
  responseRetryAfterSeconds,
  responseErrorStatus,
  responseErrorMessage,
  responseIsContextLengthError,
  boundedDiagnosticIdentifier,
  diagnosticTextFingerprint,
  responseFailureDetails,
  emitContextDiagnostic,
  emitResponseErrorDiagnostic,
  trackReasoningProtocol,
  responseUsage,
  withUsageOffset,
  responseUsageDebug,
  captureOutput,
  expectedAssistantItems,
  encodeSse,
  flushPending,
  closeContext,
} from './protocol.js';

function discardCompactionCheckpoints(entry: ConnectionEntry): void {
  if (!entry.checkpointKey) return;
  const retained = (compactionCheckpoints.get(entry.checkpointKey) ?? [])
    .filter(checkpoint => checkpoint.lineageKey !== entry.lineageKey);
  if (retained.length) compactionCheckpoints.set(entry.checkpointKey, retained);
  else compactionCheckpoints.delete(entry.checkpointKey);
  if (entry.checkpointStoreDir) {
    deleteStoredResponsesCheckpoint(
      entry.checkpointStoreDir,
      entry.checkpointKey,
      entry.lineageKey,
    );
  }
}

export function beginRecycledLineage(entry: ConnectionEntry): void {
  // Socket reuse preserves physical prompt-cache affinity, not conversation
  // identity. Save the old logical head before clearing continuation state.
  saveCompactionCheckpoint(entry);
  entry.lineageId = allocateLineageDebugId();
  entry.lineageKey = randomUUID();
  entry.responseId = undefined;
  entry.requestInput = undefined;
  entry.expectedAssistant = undefined;
  entry.requestInputHashes = undefined;
  entry.requestInputKinds = undefined;
  entry.expectedAssistantHashes = undefined;
  entry.expectedAssistantKinds = undefined;
  entry.compactedInput = undefined;
  entry.lastInputTokens = undefined;
  entry.claudeCompactionSummaryHash = undefined;
  entry.claudeAgentId = undefined;
  entry.recyclableAgentHead = false;
}

export function deleteEntry(
  entry: ConnectionEntry,
  closeSocket = true,
  saveCheckpoint = true,
): void {
  if (saveCheckpoint) saveCompactionCheckpoint(entry);
  else discardCompactionCheckpoints(entry);
  entry.inFlight = false;
  entry.current = undefined;
  unregisterEntry(entry);
  if (closeSocket) {
    try { entry.socket.close(); } catch { /* ignore */ }
  }
}

function retireSupersededEntry(ctx: RequestContext): void {
  if (!ctx.supersededEntry || ctx.supersededEntry === ctx.entry) return;
  deleteEntry(ctx.supersededEntry, true, false);
  ctx.supersededEntry = undefined;
}

export function failContext(
  entry: ConnectionEntry,
  ctx: RequestContext,
  message: string,
  diagnosticDetails: Record<string, unknown>,
  statusCode?: number,
  retryAfterSeconds?: number,
): void {
  if (ctx.closed || entry.current !== ctx) return;
  entry.debug(`fail: ${message}`);
  emitResponseErrorDiagnostic(entry, ctx, {
    ...diagnosticDetails,
    ...diagnosticTextFingerprint('errorMessage', message),
  });
  flushPending(ctx);
  encodeSse(ctx, {
    type: 'error',
    sequence_number: ctx.frameCount,
    error: {
      type: statusCode === undefined ? 'transport_error' : anthropicErrorType(statusCode),
      code: statusCode === undefined ? 'websocket_transport_error' : String(statusCode),
      message,
      param: null,
      ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
    },
  });
  // A rebased request replaces its source head only after successful
  // completion. On failure the source is still the last valid continuation.
  deleteEntry(entry);
  closeContext(ctx);
}

function retryTransportFailure(
  entry: ConnectionEntry,
  ctx: RequestContext,
  diagnosticDetails: Record<string, unknown>,
): boolean {
  const contextIsClosed = () => ctx.closed;
  if (
    ctx.closed
    || entry.current !== ctx
    || ctx.retried
    || ctx.frameCount !== 0
    || ctx.emittedModelData
  ) {
    return false;
  }

  ctx.retried = true;
  ctx.transportRetryPending = true;
  entry.debug('transport failed before any response frame; retrying once with full context');
  emitContextDiagnostic(entry, ctx, {
    event: 'ws_transport_retry',
    outcome: 'started',
    ...diagnosticDetails,
  });
  deleteEntry(entry);
  if (contextIsClosed()) {
    ctx.transportRetryPending = false;
    entry.debug('transport retry cancelled before replacement');
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'cancelled',
    });
    return true;
  }
  resetContextForRetry(ctx);
  const replacement = ctx.createReplacement();
  if (contextIsClosed()) {
    ctx.transportRetryPending = false;
    deleteEntry(replacement);
    replacement.debug('transport retry cancelled while creating replacement');
    emitContextDiagnostic(replacement, ctx, {
      event: 'ws_transport_retry',
      outcome: 'cancelled',
    });
    return true;
  }
  dispatchContext(replacement, ctx);
  return true;
}

function handleTransportFailure(
  entry: ConnectionEntry,
  ctx: RequestContext,
  message: string,
  diagnosticDetails: Record<string, unknown>,
): void {
  if (ctx.overflowRecoveryPending && !ctx.closed && entry.current === ctx) {
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_overflow_recovery',
      outcome: 'transport_closed_during_recovery',
      ...diagnosticDetails,
    });
    return;
  }
  if (retryTransportFailure(entry, ctx, diagnosticDetails)) return;
  if (ctx.closed || entry.current !== ctx) return;
  if (ctx.retried && ctx.frameCount === 0 && !ctx.emittedModelData) {
    ctx.transportRetryPending = false;
    entry.debug('transport retry exhausted before any response frame');
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'exhausted',
      ...diagnosticDetails,
    });
  }
  failContext(entry, ctx, message, diagnosticDetails);
}

export function cleanupExpiredConnections(now: number): Array<Record<string, unknown>> {
  const evictions: Array<Record<string, unknown>> = [];
  for (const entry of connectionEntries()) {
    if (entry.inFlight) continue;
    const idleTtlMs = entry.generation === 'nursery'
      ? entry.options.nurseryIdleTtlMs
      : entry.options.idleTtlMs;
    const ttlAgeMs = Math.max(0, now - entry.createdAt - entry.ttlPausedMs);
    if (ttlAgeMs >= entry.options.hardTtlMs || now - entry.lastUsedAt >= idleTtlMs) {
      entry.debug('evicting expired idle connection');
      evictions.push({
        connectionId: entry.debugId,
        partitionKey: entry.key,
        generation: entry.generation,
        reason: ttlAgeMs >= entry.options.hardTtlMs
          ? 'hard_ttl'
          : entry.generation === 'nursery' ? 'nursery_idle_ttl' : 'idle_ttl',
      });
      deleteEntry(entry);
    }
  }
  for (const [key, checkpoints] of compactionCheckpoints) {
    const retained = checkpoints.filter(checkpoint => {
      const expired = now - checkpoint.lastUsedAt >= checkpoint.ttlMs;
      if (expired) {
        if (checkpoint.checkpointStoreDir) {
          deleteStoredResponsesCheckpoint(
            checkpoint.checkpointStoreDir,
            checkpoint.key,
            checkpoint.lineageKey,
          );
        }
        evictions.push({
          connectionId: checkpoint.connectionId,
          partitionKey: checkpoint.key,
          generation: 'checkpoint',
          reason: 'checkpoint_ttl',
        });
      }
      return !expired;
    });
    if (retained.length) compactionCheckpoints.set(key, retained);
    else compactionCheckpoints.delete(key);
  }
  return evictions;
}

export function evictOldestIdleGeneration(
  generation: 'nursery' | 'established',
  maxConnections: number,
  reason: 'nursery_lru_cap' | 'established_lru_cap',
): Array<Record<string, unknown>> {
  const evictions: Array<Record<string, unknown>> = [];
  const idle = connectionEntries()
    .filter(entry => !entry.inFlight && entry.generation === generation)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  while (connectionCountByGeneration(generation) >= maxConnections && idle.length) {
    const oldest = idle.shift();
    if (oldest) {
      evictions.push({
        connectionId: oldest.debugId,
        partitionKey: oldest.key,
        generation: oldest.generation,
        reason,
      });
      deleteEntry(oldest);
    }
  }
  return evictions;
}

function reusableNurseryHead(
  key: string | undefined,
): ConnectionEntry | undefined {
  if (!key) return undefined;
  const idleNursery = connectionEntries(key)
    .filter(entry => !entry.inFlight && entry.generation === 'nursery')
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  return idleNursery.length >= RESPONSES_WS_WARM_NURSERY_CONNECTIONS_PER_PARTITION
    ? idleNursery[0]
    : undefined;
}

export function reusableCacheAffinityHead(
  key: string | undefined,
  claudeAgentId: string | undefined,
  promptFieldHashes: Record<string, string>,
): ConnectionEntry | undefined {
  return reusableNurseryHead(key)
    ?? connectionEntries(key)
      .filter(entry => (
        !entry.inFlight
        && entry.recyclableAgentHead === true
        && claudeAgentId !== undefined
        && entry.claudeAgentId !== claudeAgentId
        && changedPromptFields(entry.promptFieldHashes, promptFieldHashes).length === 0
      ))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
}

function isModelDataEvent(type: string | undefined): boolean {
  return Boolean(type && (
    type.includes('.delta')
    || type === 'response.output_item.added'
    || type === 'response.output_item.done'
  ));
}

export function outgoingPayload(payload: JsonObject): string {
  return JSON.stringify({ type: 'response.create', ...payload });
}

export type WebSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string>; proxy?: string },
) => ResponsesWebSocket;

function sendContext(entry: ConnectionEntry, ctx: RequestContext): void {
  const outgoing = outgoingPayload(ctx.sendPayload);
  const serviceTier = typeof ctx.sendPayload.service_tier === 'string'
    ? ctx.sendPayload.service_tier
    : undefined;
  entry.debug(
    `connection=${entry.debugId} key=${debugKey(entry.key)} sending ${outgoing.length}B payload`
    + (serviceTier ? ` service_tier=${serviceTier}` : '')
    + (ctx.continued ? ' (continuation)' : ''),
  );
  try {
    entry.socket.send(outgoing, error => {
      if (!error) return;
      handleTransportFailure(entry, ctx, error.message, {
        source: 'socket_send',
        failureMode: 'callback',
        socketErrorName: boundedDiagnosticIdentifier(error.name),
        socketErrorCode: boundedDiagnosticIdentifier((error as NodeJS.ErrnoException).code),
        ...diagnosticTextFingerprint('errorMessage', error.message),
      });
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('WebSocket send failed');
    handleTransportFailure(entry, ctx, failure.message, {
      source: 'socket_send',
      failureMode: 'synchronous',
      socketErrorName: boundedDiagnosticIdentifier(failure.name),
      socketErrorCode: boundedDiagnosticIdentifier((failure as NodeJS.ErrnoException).code),
      ...diagnosticTextFingerprint('errorMessage', failure.message),
    });
  }
}

export function dispatchContext(entry: ConnectionEntry, ctx: RequestContext): void {
  const now = entry.options.now();
  entry.inFlight = true;
  entry.inFlightStartedAt = now;
  entry.current = ctx;
  ctx.entry = entry;
  if (entry.open) sendContext(entry, ctx);
}

function finishInFlightPeriod(entry: ConnectionEntry, now: number): void {
  if (entry.inFlightStartedAt !== undefined) {
    entry.ttlPausedMs += Math.max(0, now - entry.inFlightStartedAt);
    entry.inFlightStartedAt = undefined;
  }
}

export function resetContextForRetry(ctx: RequestContext): void {
  ctx.continued = false;
  ctx.sendPayload = ctx.retryPayload ?? ctx.originalPayload;
  ctx.pendingEvents = [];
  ctx.emittedModelData = false;
  ctx.frameCount = 0;
  ctx.responseId = undefined;
  ctx.responseUsage = undefined;
  ctx.modelResponseUsage = undefined;
  ctx.outputByIndex.clear();
  ctx.outputIndexByItemId.clear();
  ctx.reasoningPartsByItemId.clear();
  ctx.recentUpstreamEventTypes = [];
  ctx.emittedProtocolAnomalies.clear();
}

function handleSocketMessage(entry: ConnectionEntry, data: RawData): void {
  const ctx = entry.current;
  if (!ctx || ctx.closed) return;
  if (ctx.overflowRecoveryPending) return;
  const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
  ctx.frameCount += 1;
  if (ctx.transportRetryPending) {
    ctx.transportRetryPending = false;
    entry.debug('transport retry received its first response frame');
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'recovered',
    });
  }
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    ctx.pendingEvents.push(text.replace(/\r?\n/g, ' '));
    flushPending(ctx);
    return;
  }

  const type = eventType(event);
  trackReasoningProtocol(entry, ctx, event, type);
  captureOutput(ctx, event);
  if (TERMINAL_EVENT_TYPES.has(type ?? '')) {
    ctx.modelResponseUsage = responseUsage(event);
    if (type === 'response.completed' && ctx.usageOffset) {
      event = withUsageOffset(event, ctx.usageOffset);
    }
    const usage = responseUsage(event);
    if (usage) {
      ctx.responseUsage = usage;
      entry.debug(responseUsageDebug(usage));
      ctx.emitDiagnostic?.({
        event: 'ws_response_usage',
        connectionId: entry.debugId,
        generation: entry.generation,
        continued: ctx.continued,
        retried: ctx.retried,
        ...usage,
      });
    }
  }
  if (isModelDataEvent(type)) ctx.emittedModelData = true;

  const errorCode = responseErrorCode(event);
  const previousMissing = errorCode === 'previous_response_not_found';
  const willRetry = previousMissing && ctx.continued && !ctx.retried && !ctx.emittedModelData;
  const willRecoverOverflow = responseIsContextLengthError(event)
    && !ctx.emittedModelData
    && !ctx.overflowRetried
    && ctx.recoverContextOverflow !== undefined;
  if (errorCode === 'websocket_connection_limit_reached' && !ctx.emittedModelData) {
    const retryAfterSeconds = clampRetryAfterSeconds(responseRetryAfterSeconds(event));
    failContext(
      entry,
      ctx,
      `OpenAI reported the Responses WebSocket connection limit was reached; retry after ${retryAfterSeconds}s`,
      {
        source: 'error_frame',
        errorCode,
        mappedStatusCode: 429,
        retryAfterSeconds,
      },
      429,
      retryAfterSeconds,
    );
    return;
  }
  // A bare `error` frame carrying an HTTP status is a rejected request, not a
  // response: forwarding it verbatim ends the stream with no content, so the
  // client sees an empty 200 and reports a generic failure instead of the
  // upstream reason. Map it to a real error frame while nothing has been
  // emitted yet — once model data is downstream the stream is already
  // committed, and the existing partial-output path must keep handling it.
  //
  // Resolved here, above the generic failure record, only so that record can be
  // suppressed when the rejection branch below emits its own. The branch itself
  // must stay after the `willRetry` return — ahead of it, it would swallow a
  // `previous_response_not_found` frame (which carries a 400) and kill the retry.
  const errorStatus = type === 'error' && !ctx.emittedModelData
    ? responseErrorStatus(event)
    : undefined;
  // One rejection, one diagnostic record. Without this gate a rejected request
  // emits both this record and `failContext`'s, under different `source` values
  // with disjoint fields, reading as two failures of one request.
  if (
    FAILURE_EVENT_TYPES.has(type ?? '')
    && (errorStatus === undefined || willRetry || willRecoverOverflow)
  ) {
    emitResponseErrorDiagnostic(entry, ctx, {
      source: 'response_event',
      upstreamEventType: type,
      willRetry: willRetry || willRecoverOverflow,
      retryReason: willRecoverOverflow
        ? 'overflow_rebase'
        : willRetry ? 'previous_response_missing' : undefined,
      ...responseFailureDetails(event),
    });
  }
  if (willRecoverOverflow) {
    ctx.overflowRecoveryPending = true;
    void ctx.recoverContextOverflow!(entry, ctx);
    return;
  }
  if (willRetry) {
    ctx.retried = true;
    entry.debug('previous response unavailable; retrying once with full context');
    deleteEntry(entry);
    resetContextForRetry(ctx);
    const replacement = ctx.createReplacement();
    dispatchContext(replacement, ctx);
    return;
  }

  if (errorStatus !== undefined) {
    // The AI SDK strips unknown frame fields, so a backoff hint survives only
    // baked into the message text — same reason the connection-limit branch
    // above spells it out. Clamped, so a hostile hint cannot park a client past
    // the 120s no-event stream abort.
    // Only when upstream actually gave one. `clampRetryAfterSeconds` supplies a
    // 5s DEFAULT for a missing hint, so clamping unconditionally would have
    // every 429 assert a backoff upstream never stated — and that value becomes
    // a real `retry-after` header downstream. Worse on a plan-level limit,
    // where the reason says hours: a prose-only "retry after 1800s" would get
    // "; retry after 5s" appended, and the client reads the first match.
    const statedRetryAfter = errorStatus === 429 ? responseRetryAfterSeconds(event) : undefined;
    const retryAfterSeconds = statedRetryAfter === undefined
      ? undefined
      : clampRetryAfterSeconds(statedRetryAfter);
    const reason = responseErrorMessage(event) ?? `OpenAI rejected the request (HTTP ${errorStatus})`;
    failContext(
      entry,
      ctx,
      retryAfterSeconds === undefined ? reason : `${reason}; retry after ${retryAfterSeconds}s`,
      {
        source: 'error_frame',
        // Names the failure. Without it this record — now the ONLY one for a
        // rejection — can carry no indication of what failed, since a bare
        // error frame often has no `code` at all.
        errorType: boundedDiagnosticIdentifier(responseErrorType(event)),
        // Upstream-controlled, so bounded like every other identifier in this
        // file's diagnostics. The connection-limit branch can pass its code raw
        // only because it has just been compared `===` to a known constant.
        errorCode: boundedDiagnosticIdentifier(errorCode),
        mappedStatusCode: errorStatus,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
      errorStatus,
      retryAfterSeconds,
    );
    return;
  }

  ctx.pendingEvents.push(event);
  if (isModelDataEvent(type)) flushPending(ctx);

  if (TERMINAL_EVENT_TYPES.has(type ?? '') || type === 'error') {
    flushPending(ctx);
    const failed = FAILURE_EVENT_TYPES.has(type ?? '');
    if (!failed && ctx.responseId && entry.persistent) {
      const now = entry.options.now();
      finishInFlightPeriod(entry, now);
      const assistantItems = expectedAssistantItems(ctx);
      entry.responseId = ctx.responseId;
      entry.requestInput = inputArray(ctx.originalPayload);
      entry.expectedAssistant = assistantItems;
      entry.requestInputHashes = entry.requestInput.map(conversationItemHash);
      entry.requestInputKinds = entry.requestInput.map(conversationItemKind);
      entry.expectedAssistantHashes = assistantItems.map(conversationItemHash);
      entry.expectedAssistantKinds = assistantItems.map(conversationItemKind);
      entry.compactedInput = ctx.compactedInputBase
        ? [...ctx.compactedInputBase, ...assistantItems]
        : undefined;
      entry.claudeCompactionSummaryHash = ctx.claudeCompactionRequest && entry.compactedInput
        ? compactionSummaryHash(assistantCompactionSummaryText(assistantItems))
        : ctx.claudeCompactionSummaryHash;
      entry.claudeAgentId = ctx.claudeAgentId;
      entry.recyclableAgentHead = Boolean(
        ctx.claudeAgentId
        && assistantItems.some(item => conversationItemKind(item) === 'assistant')
        && !assistantItems.some(item => {
          const kind = conversationItemKind(item);
          return kind === 'function_call' || kind === 'custom_tool_call';
        }),
      );
      entry.lastInputTokens = ctx.modelResponseUsage?.inputTokens;
      entry.promptFieldHashes = ctx.promptFieldHashes;
      entry.instructionsSnapshot = ctx.instructionsSnapshot;
      entry.lastUsedAt = now;
      entry.inFlight = false;
      entry.current = undefined;
      saveCompactionCheckpoint(entry);
      retireSupersededEntry(ctx);
      entry.debug(`chain head updated; socket retained (${ctx.frameCount} frame(s))`);
    } else {
      if (!failed) retireSupersededEntry(ctx);
      deleteEntry(entry);
    }
    if (!entry.persistent) {
      try { entry.socket.close(); } catch { /* ignore */ }
    }
    closeContext(ctx);
  }
}

function numericRetryAfterHeader(value: string | string[] | undefined): number | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && /^\d+$/.test(single.trim())
    ? Number(single.trim())
    : undefined;
}

export function createConnection(
  WebSocket: WebSocketConstructor,
  wsUrl: string,
  headers: Record<string, string>,
  persistent: boolean,
  key: string | undefined,
  checkpointKey: string | undefined,
  checkpointStoreDir: string | undefined,
  options: ConnectionEntry['options'],
  debug: ConnectionEntry['debug'],
  /** Optional HTTP(S)_PROXY URL consumed by Bun's native WebSocket client. */
  proxy?: string,
): ConnectionEntry {
  const now = options.now();
  const socket = new WebSocket(wsUrl, proxy ? { headers, proxy } : { headers });
  const entry: ConnectionEntry = {
    debugId: allocateConnectionDebugId(),
    lineageId: allocateLineageDebugId(),
    lineageKey: randomUUID(),
    key: persistent ? key : undefined,
    checkpointKey: persistent ? checkpointKey : undefined,
    checkpointStoreDir: persistent ? checkpointStoreDir : undefined,
    socket,
    persistent,
    generation: persistent ? 'nursery' : 'isolated',
    open: false,
    createdAt: now,
    ttlPausedMs: 0,
    lastUsedAt: now,
    inFlight: false,
    options,
    debug,
  };
  if (persistent && key) registerEntry(entry);
  debug(
    `connection=${entry.debugId} key=${debugKey(entry.key)} created persistent=${persistent}`,
  );

  socket.on('open', () => {
    entry.open = true;
    debug(`connection=${entry.debugId} opened`);
    // Persistent cache sockets must not keep a finished clodex CLI process alive.
    (socket as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
    const ctx = entry.current;
    if (ctx && !ctx.closed) sendContext(entry, ctx);
  });
  socket.on('unexpected-response', (_request, response) => {
    const statusCode = response.statusCode ?? 502;
    debug(`unexpected-response status=${statusCode}`);
    // Fire-and-forget drain. Upgrade failures are classified by status alone —
    // the body is never read, so nothing here is deferred into a callback.
    response.resume();
    const ctx = entry.current;
    if (!ctx || ctx.closed) {
      deleteEntry(entry);
      return;
    }
    if (statusCode === 403) {
      // OpenAI's edge/WAF rejects the upgrade with HTTP 403 when the ChatGPT
      // account's concurrency/usage throttle trips, before the request ever
      // reaches the application. Terminal conditions are 401 (re-auth) or a
      // 429 with a JSON body; the only application 403 is a geo restriction,
      // and the official codex client retries ALL 403s. Map every upgrade 403
      // to a retryable Anthropic 429 synchronously; failContext closes the
      // context here, so the socket error/close transport-retry path sees a
      // finished request and cannot double-handle this failure.
      const retryAfterSeconds = clampRetryAfterSeconds(
        numericRetryAfterHeader(response.headers['retry-after']),
      );
      // "retry after Ns" is load-bearing: the AI SDK strips unknown frame
      // fields, so sdkUpstreamErrorDetails recovers the hint from this text.
      failContext(entry, ctx, 'OpenAI edge throttled the Responses WebSocket upgrade '
        + `(HTTP 403); retry after ${retryAfterSeconds}s`, {
        source: 'unexpected_response',
        httpStatusCode: statusCode,
        mappedStatusCode: 429,
        retryAfterSeconds,
      }, 429, retryAfterSeconds);
      return;
    }
    failContext(entry, ctx, `WebSocket upgrade failed (HTTP ${statusCode})`, {
      source: 'unexpected_response',
      httpStatusCode: statusCode,
    }, statusCode);
  });
  socket.on('message', (data: RawData) => handleSocketMessage(entry, data));
  socket.on('error', (error: Error) => {
    const ctx = entry.current;
    if (ctx) {
      const details = {
        source: 'socket_error',
        socketErrorName: boundedDiagnosticIdentifier(error.name),
        socketErrorCode: boundedDiagnosticIdentifier((error as NodeJS.ErrnoException).code),
        ...diagnosticTextFingerprint('errorMessage', error.message),
      };
      handleTransportFailure(entry, ctx, error.message, details);
    } else deleteEntry(entry);
  });
  socket.on('close', (code: number, reason: Buffer) => {
    entry.open = false;
    const ctx = entry.current;
    debug(`connection=${entry.debugId} closed code=${code} in_flight=${Boolean(ctx && !ctx.closed)}`);
    if (ctx && !ctx.closed) {
      const reasonText = reason.length ? reason.toString('utf8') : '';
      const suffix = reasonText ? `: ${reasonText}` : '';
      handleTransportFailure(entry, ctx, `WebSocket closed (${code})${suffix}`, {
        source: 'socket_close',
        closeCode: code,
        ...diagnosticTextFingerprint('closeReason', reasonText),
      });
    } else {
      deleteEntry(entry, false);
    }
  });
  return entry;
}
