import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAuthorized } from './auth.js';
import {
  formatGatewayAnthropicModels,
  formatOpenAIModels,
  gatewayDisplayName,
  supportsDirectOpenAIChatCompletions,
  type GatewayModelOptions,
  type ModelCatalog,
  type ServerModelInfo,
  upstreamModelId,
} from './models.js';
import {
  translateOpenAiRequest,
  generateOpenAiResponse,
  streamOpenAiResponse,
  type OpenAiRequest,
} from '../openai-adapter.js';
import { decodeRequestBody, sendJson } from '../http-utils.js';
import { relayAnthropicMessages, resolveOAuthRetryReplacement } from '../upstream-forward.js';
import {
  anthropicPromptTooLongMessage,
  estimateAnthropicInputTokens,
} from '../anthropic-endpoints.js';
import { resolveProviderCredential } from '../env.js';
import {
  injectClaudeCodeBillingSystemLine,
  injectClaudeIdentity,
  selectBetaFlags,
} from '../oauth/claude-identity.js';
import {
  getLatestMessagePreview,
  writeInferenceRequestLog,
  writeInferenceResponseErrorLog,
  writeSecureLogLine,
  resetTraceLog,
  writeWebSocketDiagnosticLog,
  writeWebSocketDiagnosticRequestLog,
  type InferenceRequestLogEntry,
} from '../trace-log.js';
import type { LanguageModel } from 'ai';
import { createLanguageModel, isSdkMigratedNpm, maxToolsForNpm } from '../provider-factory.js';
import {
  anthropicErrorType,
  formatUpstreamError,
  isContextLengthExceededError,
  sdkUpstreamErrorDetails,
  upstreamHttpStatus,
} from '../upstream-error.js';
import { resolveContextWindow } from '../context-window.js';
import {
  translateRequest as sdkTranslateRequest,
  streamAnthropicResponse,
  generateAnthropicResponse,
  silenceSdkWarnings,
  anthropicEffortFromRequest,
  extractClaudeSessionId,
  isClaudeCodeCompactRequest,
  type AnthropicRequest,
} from '../sdk-adapter.js';
import { withResponsesWebSocketDiagnosticContext } from '../oauth/responses-websocket.js';
import { resolveOpenAiCompactionThreshold } from '../oauth/responses-compaction.js';
import { tcpListenerUrlHost } from '../listener-ready.js';
import { BunHttpResponse } from '../bun-http-response.js';

export interface ServerOptions {
  host: string;
  port: number;
  apiKey: string;
  serverPassword: string | null;
  catalog: ModelCatalog;
  gateway?: GatewayModelOptions;
  /**
   * Saved short alias names (clodex models --alias) accepted as request model
   * ids. Used only to preserve the response `model` echo: an aliased request
   * must be echoed back with the exact id the client sent so Claude Code uses
   * the matching context-window configuration.
   */
  aliasNames?: ReadonlySet<string>;
  /** When set, append structured debug lines to this file path. */
  debugLogPath?: string;
  /** When set, append privacy-minimal inference routing records as JSONL. */
  inferenceLogPath?: string;
  /** Opt-in request-envelope and WebSocket head-decision diagnostics. */
  webSocketDiagnosticsLogPath?: string;
}

export interface ServerHandle {
  host: string;
  port: number;
  url: string;
  server: Bun.Server<undefined>;
  inferenceLogPath?: string;
  close: () => Promise<void>;
}

type JsonBody = Record<string, unknown>;

function isAnthropicBody(body: JsonBody): body is JsonBody & AnthropicRequest {
  return typeof body.model === 'string' && Array.isArray(body.messages);
}

function isOpenAiBody(body: JsonBody): body is JsonBody & OpenAiRequest {
  return typeof body.model === 'string' && Array.isArray(body.messages);
}

type PLog = (msg: string | (() => string)) => void;
type LanguageModelCache = Map<string, { apiKey: string; languageModel: LanguageModel }>;

function makeServerLog(debugLogPath: string | undefined): PLog {
  if (!debugLogPath) return () => {};
  resetTraceLog(debugLogPath);
  return (msg) => writeSecureLogLine(debugLogPath, typeof msg === 'function' ? msg() : msg);
}

function auditInference(options: ServerOptions, entry: InferenceRequestLogEntry): void {
  if (options.inferenceLogPath) writeInferenceRequestLog(options.inferenceLogPath, entry);
}

function inferenceProvider(model: ServerModelInfo): string {
  return model.providerId ?? String(model.sourceBackend);
}

async function resolveModelApiKey(
  model: ServerModelInfo,
  fallback: string,
  rejectedAccessToken?: string,
): Promise<string> {
  if (model.authType === 'oauth' && model.providerId && model.authRef) {
    let current: string | null;
    try {
      current = rejectedAccessToken === undefined
        ? await resolveProviderCredential(model.providerId, model.authRef)
        : await resolveProviderCredential(
            model.providerId,
            model.authRef,
            undefined,
            { rejectedAccessToken },
          );
    } catch (cause) {
      throw new Error(
        `OAuth credential is unavailable for ${model.providerId}`,
        { cause },
      );
    }
    if (!current) {
      throw new Error(`OAuth credential is unavailable for ${model.providerId}`);
    }
    model.apiKey = current;
    return current;
  }
  return model.apiKey ?? fallback;
}

function auditSdkError(
  options: ServerOptions,
  requestedModelId: string,
  model: ServerModelInfo,
  err: unknown,
  message: string,
): { statusCode: number; retryAfterSeconds?: number } {
  const details = sdkUpstreamErrorDetails(err);
  const statusCode = details?.statusCode ?? upstreamHttpStatus(err, message);
  if (options.inferenceLogPath && statusCode >= 400) {
    writeInferenceResponseErrorLog(options.inferenceLogPath, {
      modelId: requestedModelId,
      provider: inferenceProvider(model),
      route: 'translated',
      statusCode,
      errorContent: details?.errorContent ?? message,
      isRetryable: details?.isRetryable,
      attemptCount: details?.attemptCount,
    });
  }
  return { statusCode, retryAfterSeconds: details?.retryAfterSeconds };
}

function openAiEffort(body: JsonBody): string | undefined {
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()) {
    return body.reasoning_effort.trim();
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === 'string' && effort.trim()) return effort.trim();
  }
  return undefined;
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  silenceSdkWarnings();
  const languageModelCache: LanguageModelCache = new Map();
  const plog = makeServerLog(options.debugLogPath);

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 255,
    fetch(req, bunServer) {
      const response = new BunHttpResponse();
      if (req.method === 'POST') bunServer.timeout(req, 0);
      void routeRequest(
        req,
        response as unknown as ServerResponse,
        options,
        languageModelCache,
        plog,
      ).catch(error => response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      ));
      return response.response;
    },
  });
  const boundPort = server.port;
  if (boundPort === undefined) {
    await server.stop(true);
    throw new Error('Server did not bind to a TCP port');
  }

  return {
    host: options.host,
    port: boundPort,
    url: `http://${tcpListenerUrlHost(options.host)}:${boundPort}`,
    server,
    inferenceLogPath: options.inferenceLogPath,
    close: () => server.stop(true),
  };
}

async function routeRequest(req: Request, res: ServerResponse, options: ServerOptions, modelCache: LanguageModelCache, plog: PLog): Promise<void> {
  try {
    const pathname = new URL(req.url).pathname;
    plog(`${req.method} ${pathname}`);

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!isAuthorized(req, options.serverPassword)) {
      sendJson(res, 401, { error: { message: 'Unauthorized' } });
      return;
    }

    if (req.method === 'GET' && pathname === '/models') {
      sendJson(res, 200, {
        models: options.catalog.list().map(({
          apiKey: _apiKey,
          authRef: _authRef,
          headers: _headers,
          oauthAccountId: _oauthAccountId,
          providerData: _providerData,
          ...rest
        }) => rest),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/anthropic/v1/models') {
      sendJson(res, 200, formatGatewayAnthropicModels(options.catalog.list(), options.gateway));
      return;
    }

    if (req.method === 'GET' && pathname === '/openai/v1/models') {
      sendJson(res, 200, formatOpenAIModels(options.catalog.list()));
      return;
    }

    if (req.method === 'POST' && pathname === '/anthropic/v1/messages') {
      await handleAnthropicMessages(req, res, options, modelCache, plog);
      return;
    }

    if (req.method === 'POST' && pathname === '/openai/v1/chat/completions') {
      await handleOpenAIChatCompletions(req, res, options, modelCache, plog);
      return;
    }

    sendJson(res, 404, { error: { message: 'Not found' } });
  } catch (err) {
    sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
  }
}

async function handleAnthropicMessages(
  req: Request,
  res: ServerResponse,
  options: ServerOptions,
  modelCache: LanguageModelCache,
  plog: PLog,
): Promise<void> {
  const body = await readJson(req);
  if (!body || !isAnthropicBody(body)) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const model = lookupModel(res, options.catalog, body.model);
  if (!model) {
    plog(`model not found: ${body.model}`);
    return;
  }
  const requestId = randomUUID();
  const claudeSessionIdHeader = req.headers.get('x-claude-code-session-id') ?? undefined;
  const claudeAgentIdHeader = req.headers.get('x-claude-code-agent-id') ?? undefined;
  const claudeSessionId = extractClaudeSessionId(body, claudeSessionIdHeader);
  if (options.webSocketDiagnosticsLogPath) {
    writeWebSocketDiagnosticRequestLog(options.webSocketDiagnosticsLogPath, {
      requestId,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: model.modelFormat === 'anthropic' ? 'passthrough' : 'translated',
      headers: Object.fromEntries(req.headers),
      body,
    });
  }

  plog(() => `anthropic-messages model=${body.model} format=${model.modelFormat} npm=${model.npm ?? 'none'} stream=${body.stream}`);

  if (model.modelFormat === 'anthropic') {
    if (model.baseUrl && !/^https?:\/\//i.test(model.baseUrl)) {
      sendJson(res, 400, { error: { message: `Invalid provider baseUrl: must be http:// or https://` } });
      return;
    }
    if (!model.baseUrl) {
      sendJson(res, 400, { error: { message: `Model ${model.id} has no Anthropic baseUrl configured` } });
      return;
    }
    const messagesUrl = `${model.baseUrl}/v1/messages`;
    let apiKey: string;
    try {
      apiKey = await resolveModelApiKey(model, options.apiKey);
    } catch (err) {
      sendJson(res, 401, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    const inboundBeta = req.headers.get('anthropic-beta') ?? undefined;
    const clientWantsStream = Boolean(body.stream);
    const forwardBody: Record<string, unknown> = { ...body, model: upstreamModelId(model) };
    const authType = model.authType ?? 'api';
    const isOAuth = authType === 'oauth';

    auditInference(options, {
      requestId,
      modelId: body.model,
      effort: anthropicEffortFromRequest(body) ?? model.defaultEffort,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: 'passthrough',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });

    let effectiveBeta = inboundBeta;
    let claudeCodeSessionId: string | undefined;
    if (isOAuth) {
      const seed = model.providerId ?? upstreamModelId(model);
      const identity = injectClaudeIdentity(forwardBody, model.providerData, seed);
      if (model.providerId === 'claude-code') injectClaudeCodeBillingSystemLine(forwardBody);
      claudeCodeSessionId = identity.sessionId;
      effectiveBeta = selectBetaFlags(forwardBody, upstreamModelId(model), inboundBeta);
    }

    const refreshToken = isOAuth && model.providerId && model.authRef
      ? (rejectedAccessToken: string) => resolveModelApiKey(
          model,
          options.apiKey,
          rejectedAccessToken,
        )
      : undefined;

    plog(() => `anthropic-passthrough → ${messagesUrl} oauth=${isOAuth} stream=${clientWantsStream}`);
    await relayAnthropicMessages(res, messagesUrl, forwardBody, apiKey, clientWantsStream, {
      inboundBeta: effectiveBeta,
      authType,
      log: message => plog(message),
      claudeCodeSessionId,
      extraHeaders: model.headers,
      refreshToken,
      onTokenRefreshed: refreshed => { model.apiKey = refreshed; },
      onUpstreamError: options.inferenceLogPath
        ? (statusCode, errorContent) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
            requestId,
            modelId: body.model,
            provider: inferenceProvider(model),
            route: 'passthrough',
            statusCode,
            errorContent,
          })
        : undefined,
    });
    return;
  }

  if (model.modelFormat === 'openai') {
    if (!isSdkMigratedNpm(model.npm)) {
      sendJson(res, 400, { error: { message: `No SDK provider for model: ${model.id}` } });
      return;
    }
    let apiKey: string;
    try {
      apiKey = await resolveModelApiKey(model, options.apiKey);
    } catch (err) {
      sendJson(res, 401, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    auditInference(options, {
      requestId,
      modelId: body.model,
      effort: anthropicEffortFromRequest(body) ?? model.defaultEffort,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: 'translated',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });
    const npmMaxTools = maxToolsForNpm(model.npm);
    const toolCount = Array.isArray((body as Record<string, unknown>).tools) ? ((body as Record<string, unknown>).tools as unknown[]).length : 0;
    if (npmMaxTools !== undefined && toolCount > npmMaxTools) {
      plog(`tools truncated: ${toolCount} → ${npmMaxTools} (provider limit)`);
    }
    const openAiOAuth = model.npm === '@ai-sdk/openai' && model.authType === 'oauth';
    const estimatedInputTokens = estimateAnthropicInputTokens(body);
    const forceCompaction = openAiOAuth
      && isClaudeCodeCompactRequest(body);
    const params = sdkTranslateRequest(body, model.npm!, {
      defaultEffort: anthropicEffortFromRequest(body) ? undefined : model.defaultEffort,
      openAiOAuth,
      claudeSessionId,
      reasoningMetadata: {
        providerId: model.providerId,
        apiBaseUrl: model.apiBaseUrl,
        supportedParameters: model.supportedParameters,
        reasoning: model.reasoning,
        interleavedReasoningField: model.interleavedReasoningField,
        upstreamModelId: upstreamModelId(model),
      },
      maxTools: npmMaxTools,
    });
    const clientWantsStream = Boolean(body.stream);
    // Use the display name in the response model field when masking is on — Claude
    // Desktop shows the response model field in its status bar chip, so this surfaces
    // human-readable names ("Grok 4.3 (xAI)") instead of the reversed gateway IDs.
    const responseModelId = getResponseModelId(body.model, model, options);

    const sendSdkFailure = (
      status: number,
      retryAfterSeconds: number | undefined,
      contextLengthExceeded: boolean,
      clientMessage: string,
    ): void => {
      if (!res.headersSent) {
        if (contextLengthExceeded) {
          sendJson(res, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: clientMessage },
            request_id: requestId,
          });
          return;
        }
        if (retryAfterSeconds !== undefined) {
          res.setHeader('retry-after', String(retryAfterSeconds));
        }
        sendJson(res, status === 500 ? 502 : status, { error: { message: clientMessage } });
        return;
      }
      const errorType = anthropicErrorType(status);
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: errorType, message: clientMessage },
        ...(contextLengthExceeded ? { request_id: requestId } : {}),
      })}\n\n`);
      res.end();
    };

    const sendSdkResponse = async (
      languageModel: Awaited<ReturnType<typeof getOrInitLanguageModel>>,
    ): Promise<void> => {
      if (!clientWantsStream) {
        const anthropicResponse = await withResponsesWebSocketDiagnosticContext(
          {
            requestId,
            claudeSessionId,
            claudeAgentId: claudeAgentIdHeader,
            estimatedInputTokens,
            forceCompaction,
          },
          () => generateAnthropicResponse(
            languageModel,
            params,
            responseModelId,
            { forceStream: openAiOAuth },
          ),
        );
        sendJson(res, 200, anthropicResponse);
        return;
      }
      const writeStreamChunk = (chunk: string): void => {
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
        }
        res.write(chunk);
      };
      await withResponsesWebSocketDiagnosticContext(
        {
          requestId,
          claudeSessionId,
          claudeAgentId: claudeAgentIdHeader,
          estimatedInputTokens,
          forceCompaction,
        },
        () => streamAnthropicResponse(
          languageModel,
          params,
          responseModelId,
          writeStreamChunk,
          plog,
          {
            initialInputTokens: estimatedInputTokens,
          },
        ),
      );
      if (!res.headersSent) writeStreamChunk('');
      res.end();
    };

    plog(() => `sdk npm=${model.npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

    let sdkAttempt = 0;
    for (;;) {
      try {
        const languageModel = await getOrInitLanguageModel(
          modelCache,
          model,
          model.npm!,
          model.apiBaseUrl,
          apiKey,
          options.webSocketDiagnosticsLogPath,
        );
        await sendSdkResponse(languageModel);
        break;
      } catch (err) {
        const message = formatUpstreamError(err);
        const details = sdkUpstreamErrorDetails(err);
        const candidateStatus = details?.statusCode ?? upstreamHttpStatus(err, message);
        const replacement = await resolveOAuthRetryReplacement(
          openAiOAuth,
          candidateStatus,
          sdkAttempt,
          res.headersSent,
          apiKey,
          rejectedAccessToken => resolveModelApiKey(model, options.apiKey, rejectedAccessToken),
        );
        if (replacement) {
          apiKey = replacement;
          sdkAttempt += 1;
          plog('sdk oauth credential replaced after 401; retrying once');
          continue;
        }
        const { statusCode: status, retryAfterSeconds } = auditSdkError(options, body.model, model, err, message);
        const contextLengthExceeded = status === 400
          && isContextLengthExceededError(err, message);
        const clientMessage = contextLengthExceeded
          ? anthropicPromptTooLongMessage(
              body,
              resolveContextWindow(upstreamModelId(model), model.contextWindow),
            )
          : message;
        plog(`sdk error npm=${model.npm} upstream=${upstreamModelId(model)}: ${message}`);
        sendSdkFailure(status, retryAfterSeconds, contextLengthExceeded, clientMessage);
        break;
      }
    }
    return;
  }

  sendJson(res, 400, { error: { message: `Unsupported model format: ${model.modelFormat}` } });
}

async function handleOpenAIChatCompletions(
  req: Request,
  res: ServerResponse,
  options: ServerOptions,
  modelCache: LanguageModelCache,
  plog: PLog,
): Promise<void> {
  const body = await readJson(req);
  if (!body || !isOpenAiBody(body)) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const model = lookupModel(res, options.catalog, body.model);
  if (!model) return;

  if (supportsDirectOpenAIChatCompletions(model)) {
    if (model.completionsUrl && !/^https?:\/\//i.test(model.completionsUrl)) {
      sendJson(res, 400, { error: { message: `Invalid provider completionsUrl: must be http:// or https://` } });
      return;
    }
    if (!model.completionsUrl) {
      sendJson(res, 400, { error: { message: `Model ${model.id} has no completionsUrl configured` } });
      return;
    }
    const completionsUrl = model.completionsUrl;
    let apiKey: string;
    try {
      apiKey = await resolveModelApiKey(model, options.apiKey);
    } catch (err) {
      sendJson(res, 401, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    // The client may have addressed the model via a gateway alias or saved
    // short alias — the upstream API only knows its own wire id.
    const forwardBody = body.model === upstreamModelId(model) ? body : { ...body, model: upstreamModelId(model) };
    auditInference(options, {
      modelId: body.model,
      effort: openAiEffort(body),
      provider: inferenceProvider(model),
      route: 'passthrough',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });
    const isOAuth = model.authType === 'oauth';
    const refreshToken = isOAuth && model.providerId && model.authRef
      ? (rejectedAccessToken: string) => resolveModelApiKey(
          model,
          options.apiKey,
          rejectedAccessToken,
        )
      : undefined;
    await relayAnthropicMessages(res, completionsUrl, forwardBody, apiKey, Boolean(body.stream), {
      authType: model.authType ?? 'api',
      extraHeaders: model.headers,
      refreshToken,
      onTokenRefreshed: refreshed => { model.apiKey = refreshed; },
      onUpstreamError: options.inferenceLogPath
        ? (statusCode, errorContent) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
            modelId: body.model,
            provider: inferenceProvider(model),
            route: 'passthrough',
            statusCode,
            errorContent,
          })
        : undefined,
    });
    return;
  }

  // SDK Translation Path
  const npm = model.npm || (model.modelFormat === 'anthropic' ? '@ai-sdk/anthropic' : undefined);
  if (!npm) {
    sendJson(res, 400, { error: { message: `No SDK provider for model: ${model.id}` } });
    return;
  }

  let apiKey: string;
  try {
    apiKey = await resolveModelApiKey(model, options.apiKey);
  } catch (err) {
    sendJson(res, 401, {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  auditInference(options, {
    modelId: body.model,
    effort: openAiEffort(body),
    provider: inferenceProvider(model),
    route: 'translated',
    requestPreview: getLatestMessagePreview(body.messages, body.system),
  });
  const baseURL = model.modelFormat === 'anthropic' ? model.baseUrl : model.apiBaseUrl;
  const openAiOAuth = npm === '@ai-sdk/openai' && model.authType === 'oauth';
  const params = translateOpenAiRequest(body, { openAiOAuth });
  const clientWantsStream = Boolean(body.stream);
  const responseModelId = getResponseModelId(body.model, model, options);

  plog(() => `sdk-openai npm=${npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

  let sdkAttempt = 0;
  for (;;) {
    try {
      const languageModel = await getOrInitLanguageModel(
        modelCache,
        model,
        npm,
        baseURL,
        apiKey,
      );
      if (clientWantsStream) {
        const writeStreamChunk = (chunk: string) => {
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
          }
          res.write(chunk);
        };
        await streamOpenAiResponse(languageModel, params, responseModelId, writeStreamChunk);
        if (!res.headersSent) writeStreamChunk('');
        res.end();
      } else {
        // ChatGPT/Codex OAuth routes only ever answer as SSE (the WebSocket fetch
        // returns text/event-stream unconditionally), so stream internally and
        // collect the result instead of issuing a non-streaming SDK request.
        const response = await generateOpenAiResponse(languageModel, params, responseModelId, { forceStream: openAiOAuth });
        sendJson(res, 200, response);
      }
      break;
    } catch (err) {
      const message = formatUpstreamError(err);
      const details = sdkUpstreamErrorDetails(err);
      const candidateStatus = details?.statusCode ?? upstreamHttpStatus(err, message);
      const replacement = await resolveOAuthRetryReplacement(
        openAiOAuth,
        candidateStatus,
        sdkAttempt,
        res.headersSent,
        apiKey,
        rejectedAccessToken => resolveModelApiKey(model, options.apiKey, rejectedAccessToken),
      );
      if (replacement) {
        apiKey = replacement;
        sdkAttempt += 1;
        plog('sdk oauth credential replaced after 401; retrying once');
        continue;
      }
      const { statusCode: status, retryAfterSeconds } = auditSdkError(options, body.model, model, err, message);
      plog(`sdk error npm=${model.npm} upstream=${upstreamModelId(model)}: ${message}`);
      if (!res.headersSent) {
        if (retryAfterSeconds !== undefined) res.setHeader('retry-after', String(retryAfterSeconds));
        sendJson(res, status === 500 ? 502 : status, { error: { message } });
      } else {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: status } })}\n\n`);
        res.end();
      }
      break;
    }
  }
}

function lookupModel(res: ServerResponse, catalog: ModelCatalog, modelId: unknown): ServerModelInfo | null {
  if (typeof modelId !== 'string') {
    sendJson(res, 400, { error: { message: 'Request body must include a model string' } });
    return null;
  }

  const model = catalog.get(modelId);
  if (!model) {
    sendJson(res, 400, { error: { message: `Unknown model: ${modelId}` } });
    return null;
  }

  return model;
}

async function getOrInitLanguageModel(
  modelCache: LanguageModelCache,
  model: ServerModelInfo,
  npm: string,
  baseURL: string | undefined,
  apiKey: string,
  webSocketDiagnosticsLogPath?: string,
): Promise<LanguageModel> {
  const cacheKey = [
    model.providerId ?? model.sourceBackend,
    model.id,
    upstreamModelId(model),
    npm,
    baseURL ?? '',
  ].join('\x1f');
  let cached = modelCache.get(cacheKey);
  if (!cached || cached.apiKey !== apiKey) {
    const languageModel = await createLanguageModel({
      npm,
      modelId: upstreamModelId(model),
      apiKey,
      baseURL,
      providerId: model.providerId ?? model.sourceBackend,
      authType: model.authType,
      oauthAccountId: model.oauthAccountId,
      headers: model.headers,
      useResponsesLite: model.useResponsesLite,
      preferWebSockets: model.preferWebSockets,
      openAiCompactThreshold: model.authType === 'oauth'
        ? resolveOpenAiCompactionThreshold(model.contextWindow)
        : undefined,
      openAiContextWindow: model.authType === 'oauth'
        ? resolveContextWindow(upstreamModelId(model), model.contextWindow)
        : undefined,
      onWebSocketDiagnostic: webSocketDiagnosticsLogPath
        ? event => writeWebSocketDiagnosticLog(webSocketDiagnosticsLogPath, event)
        : undefined,
    });
    cached = { apiKey, languageModel };
    modelCache.set(cacheKey, cached);
  }
  return cached.languageModel;
}

function getResponseModelId(bodyModel: unknown, model: ServerModelInfo, options: ServerOptions): string {
  // Echo invariant: a saved short alias is echoed back verbatim even when
  // masking is on — Claude Code resolves context windows from the response
  // `model` field but preflights with the request alias, so rewriting it here
  // would break auto-compaction.
  if (typeof bodyModel === 'string' && options.aliasNames?.has(bodyModel)) return bodyModel;
  return options.gateway?.maskGatewayIds
    ? gatewayDisplayName(model, options.gateway)
    : (typeof bodyModel === 'string' ? bodyModel : model.id);
}

async function readJson(req: Request): Promise<JsonBody | null> {
  try {
    const rawBytes = Buffer.from(await req.arrayBuffer());
    if (rawBytes.length > 50 * 1024 * 1024) return null;
    const raw = decodeRequestBody(rawBytes, req.headers.get('content-encoding') ?? undefined);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}
