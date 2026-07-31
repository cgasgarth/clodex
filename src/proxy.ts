// src/proxy.ts — Local Anthropic-to-OpenAI translation proxy
// Adapted from cucoleadan/opencode-cowork-proxy (MIT)
import type { ServerResponse } from 'node:http';
import { appendFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { decodeRequestBody, sendJson } from './http-utils.js';
import { formatAnthropicModelEntry, formatAnthropicModelList } from './server/models.js';
import {
  claudeCodeClientModelId,
  normalizeRouteLookupId,
  stripOneMContextSuffix,
} from './context-model-id.js';
import { routeUnavailableMessage } from './route-unavailable.js';
import {
  getProxyDebugLogPath,
  INFERENCE_PROGRESS_INTERVAL_MS,
  redactTraceLine,
  resetTraceLog,
  writeInferenceRequestLog,
  writeInferenceResponseLifecycleLog,
  writeInferenceResponseErrorLog,
  writeWebSocketDiagnosticLog,
} from './trace-log.js';
import {
  relayAnthropicMessages,
  resolveOAuthRetryReplacement,
  UpstreamUnreachableError,
} from './upstream-forward.js';
import {
  CLAUDE_CODE_CLI_VERSION,
  injectClaudeCodeBillingSystemLine,
  injectClaudeIdentity,
  selectBetaFlags,
} from './oauth/claude-identity.js';
import { createLanguageModel, isSdkMigratedNpm, maxToolsForNpm } from './provider-factory.js';
import { randomUUID } from 'node:crypto';
import {
  translateRequest as sdkTranslateRequest,
  streamAnthropicResponse,
  generateAnthropicResponse,
  extractClaudeSessionId,
  anthropicEffortFromRequest,
  isClaudeCodeCompactRequest,
  sdkTranslationErrorSignature,
  silenceSdkWarnings,
} from './sdk-adapter.js';
import {
  anthropicErrorType,
  isTransientUpstreamStatus,
  formatUpstreamError,
  isContextLengthExceededError,
  sdkUpstreamErrorDetails,
  upstreamHttpStatus,
} from './upstream-error.js';
import {
  anthropicMessagesEndpoint,
  anthropicPromptTooLongMessage,
  estimateAnthropicInputTokens,
} from './anthropic-endpoints.js';
import { withResponsesWebSocketDiagnosticContext } from './oauth/responses-websocket.js';
import { resolveOpenAiCompactionThreshold } from './oauth/responses-compaction.js';
import { resolveContextWindow } from './context-window.js';
import { getOrCreateProxyToken } from './proxy-token.js';
import { BunHttpResponse } from './bun-http-response.js';
import type { ApiProcessingMode } from './daemon/api-pricing.js';

type ProxyLog = (message: string | (() => string)) => void;

// Claude Code aborts a streaming response after ~180s without a single SSE byte.
// When an OpenAI model streams a large tool-call argument, the SDK delivers
// thousands of `tool-input-delta` parts that Relay must buffer (they are only
// flushed as one `input_json_delta` once the call completes so the input can be
// sanitized) — so the client sees dead air and disconnects mid-argument. While
// upstream is still actively delivering parts but no real output has been
// written, emit an Anthropic `ping` SSE event to keep the client's read-idle
// timer warm. Gated on recent upstream activity so a genuine upstream stall is
// still surfaced by the SDK idle watchdog rather than masked by pings forever.
const STREAM_KEEPALIVE_INTERVAL_MS = 20_000;
const STREAM_KEEPALIVE_PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const INTERNAL_ADAPTER_KEEPALIVE_TIMEOUT_MS = 60_000;

function createTranslationLifecycle(
  logPath: string | undefined,
  requestId: string | undefined,
  claudeSessionId: string | undefined,
  modelId: string,
  provider: string,
  ownsResponseLifecycle = false,
  accountId?: string,
  processingMode: ApiProcessingMode = 'standard',
  resolvedModelId?: string,
) {
  if (!logPath || !requestId) return undefined;

  const startedAt = Date.now();
  let firstPartAt: number | undefined;
  let lastPartAt: number | undefined;
  let lastPartType: string | undefined;
  let lastOutputAt: number | undefined;
  let sdkParts = 0;
  let translatedBytes = 0;
  let translatedChunks = 0;
  let stopped = false;
  let dispatched = false;

  const write = (
    event: Parameters<typeof writeInferenceResponseLifecycleLog>[1]['event'],
    extra: Partial<Parameters<typeof writeInferenceResponseLifecycleLog>[1]> = {},
  ) => writeInferenceResponseLifecycleLog(logPath, {
    event,
    requestId,
    claudeSessionId,
    accountId,
    processingMode,
    modelId,
    resolvedModelId,
    provider,
    route: 'translated',
    ...extra,
  });
  const snapshot = (now: number) => ({
    phase: !dispatched
      ? 'preparing_translation' as const
      : sdkParts === 0
        ? 'waiting_for_sdk' as const
        : 'translating' as const,
    durationMs: now - startedAt,
    sdkParts,
    ...(lastPartAt !== undefined ? { sdkIdleMs: now - lastPartAt } : {}),
    translatedBytes,
    translatedChunks,
    ...(lastOutputAt !== undefined ? { outputIdleMs: now - lastOutputAt } : {}),
    ...(lastPartType ? { lastPartType } : {}),
  });
  const timer = setInterval(() => {
    if (!stopped) write('translation_progress', snapshot(Date.now()));
  }, INFERENCE_PROGRESS_INTERVAL_MS);
  timer.unref();

  return {
    dispatched() {
      if (stopped || dispatched) return;
      dispatched = true;
      write('translation_dispatched', snapshot(Date.now()));
    },
    onPart(partType: string) {
      const now = Date.now();
      sdkParts += 1;
      lastPartAt = now;
      lastPartType = partType;
      if (firstPartAt === undefined) {
        firstPartAt = now;
        write('translation_started', {
          durationMs: now - startedAt,
          sdkParts,
          lastPartType,
        });
      }
    },
    onOutput(chunk: string) {
      translatedBytes += Buffer.byteLength(chunk);
      translatedChunks += 1;
      lastOutputAt = Date.now();
    },
    complete(usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const completed = {
        ...snapshot(Date.now()),
        ...(usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheCreationInputTokens: usage.cache_creation_input_tokens,
              cacheReadInputTokens: usage.cache_read_input_tokens,
            }
          : {}),
      };
      write('translation_completed', completed);
      if (ownsResponseLifecycle) write('response_completed', completed);
    },
    cancel(cancellationReason: 'downstream_client_abort' = 'downstream_client_abort') {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const cancelled = { ...snapshot(Date.now()), cancellationReason };
      write('translation_cancelled', cancelled);
      if (ownsResponseLifecycle) {
        write('response_client_disconnected', {
          ...cancelled,
          terminationSource: 'downstream_client',
        });
      }
    },
    fail(
      errorType: string,
      errorSignature?: string,
      errorCode?: string,
      recovery?: {
        partialResponse: boolean;
        replaySafe: boolean;
        recoveryAction: 'client_retry_request' | 'client_auto_retry_turn' | 'client_retry_turn' | 'none';
      },
    ) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const failed = {
        ...snapshot(Date.now()),
        errorType,
        errorSignature,
        errorCode,
        ...recovery,
      };
      write('translation_failed', failed);
      if (ownsResponseLifecycle) {
        write('response_failed', {
          ...failed,
          terminationSource: 'upstream_failure',
        });
      }
    },
  };
}

function appendSecureLog(logPath: string, line: string): void {
  const redacted = redactTraceLine(line);
  try {
    const fd = openSync(logPath, 'a', 0o600);
    try {
      writeSync(fd, `${new Date().toISOString()} ${redacted}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${redacted}\n`);
    } catch { /* ignore */ }
  }
}

function makeProxyLog(debug: boolean, logPath?: string): ProxyLog {
  if (!debug) return () => {};
  const path = logPath ?? getProxyDebugLogPath();
  resetTraceLog(path);
  return (message) => {
    const line = typeof message === 'function' ? message() : message;
    appendSecureLog(path, line);
  };
}

// ── HTTP server ─────────────────────────────────────────────────────

function anthropicError(res: ServerResponse, status: number, message: string, requestId?: string) {
  sendJson(res, status, {
    type: 'error',
    error: { type: anthropicErrorType(status), message },
    ...(requestId ? { request_id: requestId } : {}),
  });
}

export interface ProxyHandle {
  port: number;
  token: string;
  /** Atomically replace the live model catalog without interrupting in-flight requests. */
  replaceCatalog: (
    routes: ProxyRoute[],
    defaultAliasId: string,
    modelAliases?: ProxyModelAlias[],
  ) => void;
  close: () => void;
}

/**
 * A single entry in a proxy catalog.
 * aliasId: the id advertised in /v1/models (must start with 'claude-' or 'anthropic-')
 * realModelId: the actual model id sent to the upstream provider
 * upstreamUrl: full chat-completions URL (openai) or base URL without /v1 (anthropic)
 * apiKey: per-route upstream key. SDK routes may intentionally be empty for
 * anonymous free providers; passthrough and Cloud Code routes still require it.
 */
export interface ProxyRoute {
  aliasId: string;
  realModelId: string;
  displayName: string;
  upstreamUrl: string;
  apiKey: string;
  modelFormat: 'anthropic' | 'openai';
  contextWindow?: number;
  npm?: string;      // OpenCode api.npm — when SDK-migrated, routes via the adapter
  baseURL?: string;  // base URL for openai-compatible / openrouter SDK providers
  providerId?: string;
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  /** Local managed-account id used only for privacy-minimal daemon metrics. */
  metricsAccountId?: string;
  providerData?: Record<string, unknown>;
  /** Resolves the current OAuth token before dispatch and once more after an upstream HTTP 401. */
  refreshToken?: (rejectedAccessToken?: string) => Promise<string | null>;
  supportedParameters?: string[];
  reasoning?: boolean;
  interleavedReasoningField?: string;
  /** Backend capability: model requires the Responses-Lite request shape (x-openai-internal-codex-responses-lite). */
  useResponsesLite?: boolean;
  /** Backend capability: model must use the WebSocket Responses transport instead of HTTP. */
  preferWebSockets?: boolean;
  /** Static headers sent on every upstream request (e.g. a plan/auth-tracking header a custom endpoint requires). */
  headers?: Record<string, string>;
}

/**
 * Produce a gateway-discovery-safe alias for a model id.
 * Claude Code's gateway discovery only shows ids starting with 'claude' or 'anthropic'.
 * claude-* ids are returned unchanged; everything else gets an 'anthropic-{providerId}__' prefix.
 * Uses stable provider id (slug), not display name — renaming a provider does not break aliases.
 */
export function aliasModelId(realId: string, providerId: string): string {
  if (realId.startsWith('claude-')) return realId;
  const sanitized = providerId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `anthropic-${sanitized}__${realId}`;
}

/** Resolve catalog alias when Claude Code or legacy registry ids differ by prefix/suffix. */
function lookupRoute(byAlias: Map<string, ProxyRoute>, id: string): ProxyRoute | undefined {
  return byAlias.get(normalizeRouteLookupId(id));
}

/** Short alias name → route id, resolvable in request bodies alongside route aliasIds. */
export interface ProxyModelAlias {
  name: string;
  /** Exact spelling retained in configuration, used only for diagnostics and blocking. */
  savedName?: string;
  /** All exact saved spellings represented by this canonical alias. Never routed. */
  sourceNames?: string[];
  routeId?: string;
  unavailableReason?: string;
}

export type ProxyRouteRequestResolver = (
  route: ProxyRoute,
  context: { launchTicket?: string },
) => Promise<ProxyRoute>;

export interface ProxyRequestOptimizationContext {
  requestId: string;
  body: Buffer;
  request: Record<string, unknown>;
  endpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>;
  claudeSessionId?: string;
  claudeAgentId?: string;
  route: ProxyRoute;
  processingMode: ApiProcessingMode;
}

export type ProxyRequestOptimizer = (
  context: ProxyRequestOptimizationContext,
) => Promise<Buffer>;

function configuredAliasLookupNames(alias: ProxyModelAlias): string[] {
  const sourceNames = [
    alias.name,
    ...(alias.savedName === undefined ? [] : [alias.savedName]),
    ...(alias.sourceNames ?? []),
  ];
  return [...new Set(sourceNames.flatMap(name => {
    const trimmed = name.trim();
    return trimmed === name ? [name] : [name, trimmed];
  }))].map(normalizeRouteLookupId);
}

interface ProxyCatalogState {
  byAlias: Map<string, ProxyRoute>;
  configuredAliasNames: Set<string>;
  unavailableAliasReasons: Map<string, string>;
  defaultRoute: ProxyRoute;
  modelsPayload: string;
}

function createProxyCatalogState(
  routes: ProxyRoute[],
  defaultAliasId: string,
  modelAliases: ProxyModelAlias[] = [],
): ProxyCatalogState {
  if (routes.length === 0) {
    throw new Error('Proxy catalog requires at least one route');
  }
  const byAlias = new Map(routes.map(route => [normalizeRouteLookupId(route.aliasId), route]));
  const configuredAliasNames = new Set(modelAliases.flatMap(configuredAliasLookupNames));
  const unavailableAliasReasons = new Map(
    modelAliases
      .filter(alias => alias.unavailableReason !== undefined)
      .flatMap(alias => configuredAliasLookupNames(alias).map(name => (
        [name, alias.unavailableReason!] as const
      ))),
  );
  for (const alias of modelAliases) {
    if (alias.routeId === undefined || alias.unavailableReason !== undefined) continue;
    const route = lookupRoute(byAlias, alias.routeId);
    const aliasId = normalizeRouteLookupId(alias.name);
    if (route && !byAlias.has(aliasId)) byAlias.set(aliasId, route);
  }
  const defaultRoute = lookupRoute(byAlias, defaultAliasId) ?? routes[0]!;
  return {
    byAlias,
    configuredAliasNames,
    unavailableAliasReasons,
    defaultRoute,
    modelsPayload: JSON.stringify(
      formatAnthropicModelList(
        routes.map(route => ({
          id: route.aliasId,
          name: route.displayName,
          contextWindow: route.contextWindow,
        })),
      ),
    ),
  };
}

/** Multi-model proxy: routes each request by body.model to the correct upstream. */
export async function startProxyCatalog(
  routes: ProxyRoute[],
  defaultAliasId: string,
  debug = false,
  inferenceLogPath?: string,
  debugLogPath?: string,
  webSocketDiagnosticsLogPath?: string,
  modelAliases?: ProxyModelAlias[],
  resolveRouteForRequest?: ProxyRouteRequestResolver,
  port = 0,
  optimizeRequest?: ProxyRequestOptimizer,
): Promise<ProxyHandle> {
  const proxyToken = getOrCreateProxyToken();
  silenceSdkWarnings();

  let catalog = createProxyCatalogState(routes, defaultAliasId, modelAliases);

  const plog = makeProxyLog(debug, debugLogPath);

  const onRejection = (reason: unknown) => {
    plog(() => `Unhandled Rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  };
  const onException = (error: Error) => {
    plog(() => `Uncaught Exception: ${error.stack || error.message}`);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      idleTimeout: INTERNAL_ADAPTER_KEEPALIVE_TIMEOUT_MS / 1_000,
      async fetch(req, bunServer) {
        const requestUrl = new URL(req.url);
        const requestPath = `${requestUrl.pathname}${requestUrl.search}`;
        const response = new BunHttpResponse();
        const res = response as unknown as ServerResponse;
        const run = async () => {
          plog(() => `${req.method} ${requestPath}`);

    // HEAD / — health check ping from Claude Code
    if (req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }

    // GET /v1/models — Claude Code validates the model on startup and populates /model picker
    if (req.method === 'GET' && requestPath.startsWith('/v1/models')) {
      const requestCatalog = catalog;
      const modelPathMatch = requestPath.match(/^\/v1\/models\/([^?]+)/);
      if (modelPathMatch) {
        const id = decodeURIComponent(modelPathMatch[1]);
        const route = lookupRoute(requestCatalog.byAlias, id);
        if (route) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(formatAnthropicModelEntry(route.aliasId, route.displayName, route.contextWindow)));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'not_found_error', message: `Model '${id}' not found` } }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(requestCatalog.modelsPayload);
      }
      return;
    }

    const messagesEndpoint = anthropicMessagesEndpoint(requestPath);

    // Anthropic message creation and token counting are distinct endpoints.
    if (req.method === 'POST' && messagesEndpoint) {
      bunServer.timeout(req, 0);
      const inboundKey = req.headers.get('x-api-key')
        ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
        ?? null;
      const ticketPrefix = `${proxyToken}.`;
      const launchTicketFromKey = inboundKey?.startsWith(ticketPrefix)
        ? inboundKey.slice(ticketPrefix.length)
        : undefined;
      if (inboundKey !== proxyToken && !launchTicketFromKey) {
        anthropicError(res, 401, 'Invalid proxy token');
        return;
      }

      const clientAbort = new AbortController();
      const abortForClientDisconnect = () => {
        if (!clientAbort.signal.aborted) clientAbort.abort(new Error('Client disconnected'));
      };
      req.signal.addEventListener('abort', abortForClientDisconnect, { once: true });
      response.setClientCancelHandler(abortForClientDisconnect);

      let decodedBody: Buffer;
      let anthropicBody: any;
      try {
        const rawBytes = Buffer.from(await req.arrayBuffer());
        if (rawBytes.length > 50 * 1024 * 1024) throw new Error('Request body too large');
        const raw = decodeRequestBody(rawBytes, req.headers.get('content-encoding') ?? undefined);
        decodedBody = Buffer.from(raw);
        anthropicBody = JSON.parse(raw);
      } catch {
        anthropicError(res, 400, 'Invalid JSON body');
        return;
      }

      const originalModel = anthropicBody.model;
      const requestCatalog = catalog;
      const clientWantsStream = Boolean(anthropicBody.stream);
      const forwardedRequestId = req.headers.get('x-relay-request-id') ?? undefined;
      const relayRequestId = forwardedRequestId ?? randomUUID();

      // Per-request route resolution: look up the alias, fall back to default
      const resolvedRoute = typeof originalModel === 'string'
        ? lookupRoute(requestCatalog.byAlias, originalModel)
        : undefined;
      const configuredModelUnavailable = typeof originalModel === 'string'
        && (
          normalizeRouteLookupId(originalModel).startsWith('clodex:')
          || requestCatalog.configuredAliasNames.has(normalizeRouteLookupId(originalModel))
        );
      if (!resolvedRoute && configuredModelUnavailable) {
        anthropicError(
          res,
          400,
          routeUnavailableMessage(
            originalModel,
            requestCatalog.unavailableAliasReasons.get(normalizeRouteLookupId(originalModel)),
          ),
        );
        return;
      }
      let route = resolvedRoute ?? requestCatalog.defaultRoute;
      if (resolveRouteForRequest) {
        const launchTicketFromHeader = req.headers.get('x-clodex-launch-ticket') ?? undefined;
        try {
          route = await resolveRouteForRequest(route, {
            launchTicket: launchTicketFromHeader ?? launchTicketFromKey,
          });
        } catch (error) {
          anthropicError(
            res,
            401,
            error instanceof Error ? error.message : 'Managed account is unavailable',
          );
          return;
        }
      }
      const claudeSessionIdHeader = req.headers.get('x-claude-code-session-id') ?? undefined;
      const claudeAgentIdHeader = req.headers.get('x-claude-code-agent-id') ?? undefined;
      const claudeSessionId = extractClaudeSessionId(anthropicBody, claudeSessionIdHeader);
      const processingMode: ApiProcessingMode = 'standard';
      if (optimizeRequest) {
        const optimizedBody = await optimizeRequest({
          requestId: relayRequestId,
          body: decodedBody,
          request: anthropicBody,
          endpoint: messagesEndpoint,
          claudeSessionId,
          claudeAgentId: claudeAgentIdHeader,
          route,
          processingMode,
        });
        if (optimizedBody !== decodedBody) {
          try {
            anthropicBody = JSON.parse(optimizedBody.toString('utf8'));
          } catch {
            // Optional middleware is fail-open. A malformed rewrite must not
            // prevent the original inference request from reaching its route.
          }
        }
      }
      if (messagesEndpoint === 'count_tokens' && route.modelFormat !== 'anthropic') {
        const inputTokens = estimateAnthropicInputTokens(anthropicBody);
        plog(() => `token-count: local estimate model=${originalModel} input_tokens=${inputTokens}`);
        res.setHeader('x-relay-token-count-source', 'local-estimate');
        sendJson(res, 200, { input_tokens: inputTokens });
        return;
      }

      let apiKey = route.apiKey;
      if (route.authType === 'oauth' && route.refreshToken) {
        try {
          const current = await route.refreshToken();
          if (!current) throw new Error('credential is missing');
          apiKey = current;
          route.apiKey = current;
        } catch (err) {
          plog(() =>
            `oauth credential unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
          anthropicError(res, 401, 'OAuth credential is unavailable');
          return;
        }
      }
      const upstreamUrl = route.upstreamUrl;
      const routeAuthType = route.authType ?? 'api';

      plog(() =>
        `POST /v1/messages - alias=${originalModel} route=${route.realModelId} format=${route.modelFormat} key=${routeAuthType === 'none' ? 'none' : apiKey ? `len:${apiKey.length}` : 'MISSING'}`,
      );

      const usesSdkAdapter = isSdkMigratedNpm(route.npm);

      if (messagesEndpoint === 'count_tokens') {
        if (!apiKey && routeAuthType !== 'none') {
          anthropicError(res, 401, 'Missing API key');
          return;
        }

        const inboundBeta = req.headers.get('anthropic-beta') ?? undefined;
        const forwardBody = { ...anthropicBody, model: route.realModelId };
        const targetUrl = `${upstreamUrl}/v1/messages/count_tokens`;
        const isOAuth = routeAuthType === 'oauth';
        try {
          await relayAnthropicMessages(res, targetUrl, forwardBody, apiKey, false, {
            inboundBeta,
            authType: routeAuthType,
            log: message => plog(message),
            extraHeaders: route.headers,
            refreshToken: route.refreshToken,
            onTokenRefreshed: refreshed => { route.apiKey = refreshed; },
            signal: clientAbort.signal,
          });
        } catch (err) {
          if (clientAbort.signal.aborted) return;
          const message = err instanceof UpstreamUnreachableError ? err.message : String(err);
          plog(() => `anthropic token-count error: ${message}`);
          anthropicError(res, 502, message);
        }
        return;
      }

      if (!apiKey && routeAuthType !== 'none' && !usesSdkAdapter) {
        anthropicError(res, 401, 'Missing API key');
        return;
      }

      // ── Anthropic passthrough ───────────────────────────────────────
      // Forward raw Anthropic body (with real model id) directly to the upstream.
      // No translation needed — the upstream speaks Anthropic natively.
      if (route.modelFormat === 'anthropic') {
        const inboundBeta = req.headers.get('anthropic-beta') ?? undefined;
        const forwardBody = { ...anthropicBody, model: route.realModelId };
        const targetUrl = `${upstreamUrl}/v1/messages`;
        const isOAuth = routeAuthType === 'oauth';

        let effectiveBeta = inboundBeta;
        let claudeCodeSessionId: string | undefined;
        if (isOAuth) {
          // Identity injection and beta selection for Claude Code OAuth.
          const seed = route.providerId ?? route.realModelId;
          const identity = injectClaudeIdentity(forwardBody, route.providerData, seed);
          if (route.providerId === 'claude-code') injectClaudeCodeBillingSystemLine(forwardBody);
          claudeCodeSessionId = identity.sessionId;
          effectiveBeta = selectBetaFlags(forwardBody, route.realModelId, inboundBeta);
          plog(() => `anthropic-oauth: model=${route.realModelId}, beta=${effectiveBeta}`);
          plog(() => `anthropic-oauth headers: user-agent=claude-cli/${CLAUDE_CODE_CLI_VERSION} x-app=cli session-header=${claudeCodeSessionId ? 'set' : 'missing'}`);
        } else {
          plog(() => `anthropic-passthrough: model=${route.realModelId}, stream=${clientWantsStream}`);
        }

        try {
          await relayAnthropicMessages(res, targetUrl, forwardBody, apiKey, clientWantsStream, {
            inboundBeta: effectiveBeta,
            authType: routeAuthType,
            log: message => plog(message),
            claudeCodeSessionId,
            extraHeaders: route.headers,
            refreshToken: route.refreshToken,
            onTokenRefreshed: refreshed => { route.apiKey = refreshed; },
            signal: clientAbort.signal,
            onUpstreamError: inferenceLogPath
              ? (statusCode, errorContent) => writeInferenceResponseErrorLog(inferenceLogPath, {
                  modelId: originalModel,
                  provider: route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown',
                  route: 'passthrough',
                  statusCode,
                  errorContent,
                })
              : undefined,
          });
        } catch (err) {
          if (clientAbort.signal.aborted) return;
          const message = err instanceof UpstreamUnreachableError ? err.message : String(err);
          plog(() => `anthropic-passthrough error: ${message}`);
          anthropicError(res, 502, message);
        }
        return;
      }

      // ── SDK-backed providers (Vercel AI SDK) ────────────────────────
      // OpenCode-assigned npm packages route through the SDK, which owns wire
      // format, endpoint selection, and provider quirks.
      if (usesSdkAdapter) {
        const openAiOAuth = route.npm === '@ai-sdk/openai' && route.authType === 'oauth';
        // Current requests use Standard processing. The metrics pipeline also
        // accepts `fast`; the session-scoped /fast transport work will set this
        // from the actual outbound service tier when it enables Priority.
        if (inferenceLogPath && !forwardedRequestId) {
          writeInferenceRequestLog(inferenceLogPath, {
            requestId: relayRequestId,
            claudeSessionId,
            accountId: route.metricsAccountId,
            processingMode,
            modelId: typeof originalModel === 'string' ? originalModel : 'unknown',
            resolvedModelId: route.realModelId,
            effort: anthropicEffortFromRequest(anthropicBody),
            provider: route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown',
            route: 'translated',
            stream: clientWantsStream,
          });
        }
        const translationLifecycle = createTranslationLifecycle(
          inferenceLogPath,
          relayRequestId,
          claudeSessionId,
          originalModel,
          route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown',
          !forwardedRequestId,
          route.metricsAccountId,
          processingMode,
          route.realModelId,
        );
        const cancelTranslation = () => translationLifecycle?.cancel('downstream_client_abort');
        if (clientAbort.signal.aborted) cancelTranslation();
        else clientAbort.signal.addEventListener('abort', cancelTranslation, { once: true });
        const runSdkRequest = async (): Promise<void> => {
          const estimatedInputTokens = estimateAnthropicInputTokens(anthropicBody);
          const forceCompaction = openAiOAuth
            && isClaudeCodeCompactRequest(anthropicBody);
          const params = sdkTranslateRequest(anthropicBody, route.npm!, {
            openAiOAuth,
            claudeSessionId,
            maxTools: maxToolsForNpm(route.npm),
            reasoningMetadata: {
              providerId: route.providerId,
              apiBaseUrl: route.baseURL,
              supportedParameters: route.supportedParameters,
              reasoning: route.reasoning,
              interleavedReasoningField: route.interleavedReasoningField,
              upstreamModelId: route.realModelId,
            },
          });
          plog(() =>
            `sdk: npm=${route.npm} model=${route.realModelId}, stream=${clientWantsStream}, ` +
            `tools=${anthropicBody.tools?.length ?? 0}, msgs=${params.messages.length}`,
          );
          const model = await createLanguageModel({
            npm: route.npm!,
            modelId: route.realModelId,
            apiKey,
            baseURL: route.baseURL,
            providerId: route.providerId ?? route.aliasId,
            authType: route.authType,
            oauthAccountId: route.oauthAccountId,
            providerData: route.providerData,
            headers: route.headers,
            useResponsesLite: route.useResponsesLite,
            preferWebSockets: route.preferWebSockets,
            openAiCompactThreshold: openAiOAuth
              ? resolveOpenAiCompactionThreshold(route.contextWindow)
              : undefined,
            openAiContextWindow: openAiOAuth
              ? resolveContextWindow(route.realModelId, route.contextWindow)
              : undefined,
            onDebug: (msg: string) => plog(() => msg),
            onWebSocketDiagnostic: webSocketDiagnosticsLogPath
              ? event => writeWebSocketDiagnosticLog(webSocketDiagnosticsLogPath, event)
              : undefined,
          });
          translationLifecycle?.dispatched();
          if (clientWantsStream) {
            // Internal override (primarily a test seam / operational tuning knob).
            const keepAliveMs =
              Number(process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS) || STREAM_KEEPALIVE_INTERVAL_MS;
            let lastDownstreamWriteAt = Date.now();
            let lastUpstreamPartAt = Date.now();
            const writeStreamChunk = (chunk: string) => {
              translationLifecycle?.onOutput(chunk);
              if (!res.headersSent) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                });
              }
              lastDownstreamWriteAt = Date.now();
              res.write(chunk);
            };
            // Heartbeat: while upstream keeps delivering parts but nothing has
            // been written downstream for a full interval (a large tool-call
            // argument being buffered), emit a ping so Claude Code's ~180s
            // read-idle timeout does not fire mid-argument. Deliberately does
            // NOT go through translationLifecycle.onOutput so diagnostic
            // outputIdleMs still reflects the real buffering gap.
            const keepAlive = setInterval(() => {
              if (res.writableEnded || !res.headersSent) return;
              const now = Date.now();
              const outputIdleMs = now - lastDownstreamWriteAt;
              const upstreamIdleMs = now - lastUpstreamPartAt;
              if (outputIdleMs >= keepAliveMs && upstreamIdleMs < keepAliveMs) {
                lastDownstreamWriteAt = now;
                res.write(STREAM_KEEPALIVE_PING);
                plog(() => `stream keepalive ping: output idle ${outputIdleMs}ms, upstream active (${upstreamIdleMs}ms since last part)`);
              }
            }, keepAliveMs);
            keepAlive.unref();
            let finalUsage: {
              input_tokens: number;
              output_tokens: number;
              cache_creation_input_tokens: number;
              cache_read_input_tokens: number;
            } | undefined;
            try {
              await withResponsesWebSocketDiagnosticContext(
                {
                  requestId: relayRequestId,
                  claudeSessionId,
                  claudeAgentId: claudeAgentIdHeader,
                  estimatedInputTokens,
                  forceCompaction,
                },
                () => streamAnthropicResponse(
                  model,
                  params,
                  originalModel,
                  writeStreamChunk,
                  plog,
                  {
                    onPart: partType => {
                      lastUpstreamPartAt = Date.now();
                      translationLifecycle?.onPart(partType);
                    },
                    onUsage: usage => { finalUsage = usage; },
                    initialInputTokens: estimatedInputTokens,
                    abortSignal: clientAbort.signal,
                  },
                ),
              );
            } finally {
              clearInterval(keepAlive);
            }
            translationLifecycle?.complete(finalUsage);
            if (!res.headersSent) writeStreamChunk('');
            res.end();
          } else {
            // ChatGPT's Codex backend (OpenAI OAuth) rejects non-streaming requests
            // outright ("Stream must be set to true"), so always stream internally
            // for it and collect the result, regardless of what the client asked for.
            const anthropicResponse = await withResponsesWebSocketDiagnosticContext(
              {
                requestId: relayRequestId,
                claudeSessionId,
                claudeAgentId: claudeAgentIdHeader,
                estimatedInputTokens,
                forceCompaction,
              },
              () => generateAnthropicResponse(
                model,
                params,
                originalModel,
                {
                  forceStream: openAiOAuth,
                  abortSignal: clientAbort.signal,
                  onPart: partType => translationLifecycle?.onPart(partType),
                },
              ),
            );
            translationLifecycle?.onOutput(JSON.stringify(anthropicResponse));
            translationLifecycle?.complete(
              anthropicResponse['usage'] as {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              } | undefined,
            );
            sendJson(res, 200, anthropicResponse);
          }
        };

        let sdkAttempt = 0;
        const handleSdkError = async (
          err: unknown,
        ): Promise<'retry' | 'cancelled' | 'done'> => {
          if (clientAbort.signal.aborted) {
            translationLifecycle?.cancel();
            return 'cancelled';
          }
          const message = formatUpstreamError(err);
          const details = sdkUpstreamErrorDetails(err);
          const upstreamStatus = details?.statusCode ?? upstreamHttpStatus(err, message);
          const replacement = await resolveOAuthRetryReplacement(
            openAiOAuth,
            upstreamStatus,
            sdkAttempt,
            res.headersSent,
            apiKey,
            route.refreshToken,
          );
          if (replacement) {
            apiKey = replacement;
            route.apiKey = replacement;
            sdkAttempt += 1;
            plog(() => 'sdk oauth credential replaced after 401; retrying once');
            return 'retry';
          }
          const partialResponse = res.headersSent;
          const replaySafe = !partialResponse;
          const clientRetryable = details?.isRetryable
            ?? isTransientUpstreamStatus(upstreamStatus);
          const recoveryAction = partialResponse
            ? clientRetryable ? 'client_auto_retry_turn' : 'client_retry_turn'
            : clientRetryable ? 'client_retry_request' : 'none';
          translationLifecycle?.fail(
            err instanceof Error ? err.name : 'UpstreamError',
            sdkTranslationErrorSignature(err),
            details?.transportCode,
            { partialResponse, replaySafe, recoveryAction },
          );
          const contextLengthExceeded = upstreamStatus === 400
            && isContextLengthExceededError(err, message);
          let clientMessage = contextLengthExceeded
            ? anthropicPromptTooLongMessage(
                anthropicBody,
                resolveContextWindow(route.realModelId, route.contextWindow),
              )
            : message;
          if (partialResponse) {
            clientMessage += clientRetryable
              ? ' The upstream stream ended after partial output. Claude Code can automatically retry this transient interruption; Clodex did not replay it server-side because doing so could duplicate text or tool calls.'
              : ' The upstream stream ended after partial output. Clodex did not replay the request because doing so could duplicate text or tool calls; retry or continue the turn in Claude Code.';
          }
          plog(() => `sdk error: ${message}${details?.errorContent ? ` — body: ${details.errorContent}` : ''}`);
          if (inferenceLogPath && upstreamStatus >= 400) {
            writeInferenceResponseErrorLog(inferenceLogPath, {
              ...(relayRequestId ? { requestId: relayRequestId } : {}),
              ...(claudeSessionId ? { claudeSessionId } : {}),
              ...(claudeAgentIdHeader ? { claudeAgentId: claudeAgentIdHeader } : {}),
              modelId: originalModel,
              provider: route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown',
              route: 'translated',
              statusCode: upstreamStatus,
              errorContent: details?.errorContent ?? message,
              isRetryable: clientRetryable,
              attemptCount: details?.attemptCount,
              partialResponse,
              replaySafe,
              recoveryAction,
            });
          }
          if (!res.headersSent) {
            if (details?.retryAfterSeconds !== undefined) {
              res.setHeader('retry-after', String(details.retryAfterSeconds));
            }
            anthropicError(
              res,
              upstreamStatus === 500 ? 502 : upstreamStatus,
              clientMessage,
              contextLengthExceeded ? (relayRequestId ?? randomUUID()) : undefined,
            );
          } else {
            const errorType = anthropicErrorType(upstreamStatus);
            res.write(`event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: errorType, message: clientMessage },
              request_id: relayRequestId ?? randomUUID(),
            })}\n\n`);
            res.end();
          }
          return 'done';
        };

        for (;;) {
          try {
            await runSdkRequest();
            break;
          } catch (err) {
            const outcome = await handleSdkError(err);
            if (outcome === 'retry') continue;
            if (outcome === 'cancelled') return;
            break;
          }
        }
        return;
      }

      // Non-anthropic route without a registered SDK npm — misconfigured route.
      anthropicError(res, 500, `No SDK provider configured for model ${originalModel} (npm=${route.npm ?? 'none'})`);
      return;
    }

    // Everything else → 404
    anthropicError(res, 404, `Unknown endpoint: ${req.method} ${requestPath}`);
        };
        void run().catch(error => {
          plog(() => `request handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          if (!response.headersSent) {
            anthropicError(res, 500, 'Internal proxy error');
          } else {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
        return response.response;
      },
    });
  } catch (error) {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    throw error;
  }
  const boundPort = server.port;
  if (boundPort === undefined) {
    await server.stop(true);
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    throw new Error('Proxy did not bind to a TCP port');
  }
  plog(() =>
    `started on port ${boundPort}, catalog=${routes.length} model(s), default=${catalog.defaultRoute.aliasId}`,
  );
  return {
    port: boundPort,
    token: proxyToken,
    replaceCatalog: (nextRoutes, nextDefaultAliasId, nextModelAliases) => {
      catalog = createProxyCatalogState(
        nextRoutes,
        nextDefaultAliasId,
        nextModelAliases,
      );
      plog(() =>
        `catalog replaced: ${nextRoutes.length} model(s), default=${catalog.defaultRoute.aliasId}`,
      );
    },
    close: () => {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
      void server.stop(true);
    },
  };
}

/** Single-model proxy — backward-compatible wrapper around startProxyCatalog. */
export function startProxy(
  completionsUrl: string,
  modelId: string,
  debug = false,
  contextWindow?: number,
  sdk?: {
    npm?: string;
    baseURL?: string;
    upstreamModelId?: string;
    providerId?: string;
    authType?: 'api' | 'oauth' | 'none';
    oauthAccountId?: string;
    providerData?: Record<string, unknown>;
    modelFormat?: 'anthropic' | 'openai';
    supportedParameters?: string[];
    reasoning?: boolean;
    interleavedReasoningField?: string;
    useResponsesLite?: boolean;
    preferWebSockets?: boolean;
    headers?: Record<string, string>;
  },
  apiKey?: string,
): Promise<ProxyHandle> {
  const bareModelId = stripOneMContextSuffix(modelId);
  const clientModelId = claudeCodeClientModelId(modelId, contextWindow);
  return startProxyCatalog([{
    aliasId: clientModelId,
    realModelId: sdk?.upstreamModelId ?? bareModelId,
    displayName: bareModelId,
    upstreamUrl: completionsUrl,
    apiKey: apiKey ?? '',
    modelFormat: sdk?.modelFormat ?? 'openai',
    contextWindow,
    npm: sdk?.npm,
    baseURL: sdk?.baseURL,
    providerId: sdk?.providerId,
    authType: sdk?.authType,
    oauthAccountId: sdk?.oauthAccountId,
    providerData: sdk?.providerData,
    supportedParameters: sdk?.supportedParameters,
    reasoning: sdk?.reasoning,
    interleavedReasoningField: sdk?.interleavedReasoningField,
    useResponsesLite: sdk?.useResponsesLite,
    preferWebSockets: sdk?.preferWebSockets,
    headers: sdk?.headers,
  }], clientModelId, debug);
}
