import { importActual } from './bun-import-actual.js';
// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from 'bun:test';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliasModelId, startProxy, startProxyCatalog, type ProxyRoute } from '../src/proxy/index.js';
import { makeRouteResolver, resolveCatalogModelAliases } from '../src/models/catalog.js';
import { flushTraceLogs, getProxyDebugLogPath } from '../src/observability/trace-log.js';
import {
  anthropicMessagesEndpoint,
  estimateAnthropicInputTokens,
  normalizeAnthropicGatewayPath,
} from '../src/providers/anthropic-endpoints.js';
import { withResponsesWebSocketDiagnosticContext } from '../src/oauth/responses-websocket.js';
import type { LocalProvider, ModelAlias } from '../src/types.js';
import {
  asMocked,
  requireTcpAddress,
  restoreTestGlobals,
  stubTestGlobal,
  waitForCondition,
  type JsonObject,
  type JsonValue,
} from './test-helpers.js';

async function readFlushedLog(path: string): Promise<string> {
  await flushTraceLogs(path);
  return readFileSync(path, 'utf8');
}

function openAiSseChunk(delta: JsonObject, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'c', object: 'chat.completion.chunk', created: 1, model: 'translated-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

vi.mock('../src/oauth/responses-websocket.js', () => {
  const actual = importActual<typeof import('../src/oauth/responses-websocket.js')>('../src/oauth/responses-websocket.js', import.meta.url);
  return {
    ...actual,
    withResponsesWebSocketDiagnosticContext: vi.fn(
      actual.withResponsesWebSocketDiagnosticContext,
    ),
  };
});

/** POST JSON to a local proxy via node:http (avoids stubTestGlobal('fetch') interception). */
function postToProxy(
  port: number,
  token: string,
  body: JsonValue,
  relayRequestId?: string,
  path = '/v1/messages',
  claudeSessionId?: string,
  claudeAgentId?: string,
  onChunk?: (chunk: string) => void,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (relayRequestId) headers['x-relay-request-id'] = relayRequestId;
    if (claudeSessionId) headers['x-claude-code-session-id'] = claudeSessionId;
    if (claudeAgentId) headers['x-claude-code-agent-id'] = claudeAgentId;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          const text = chunk.toString();
          data += text;
          onChunk?.(text);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('Anthropic endpoint routing', () => {
  it('matches messages and count_tokens exactly, including query strings', () => {
    expect(anthropicMessagesEndpoint('/v1/messages?beta=true')).toBe('messages');
    expect(anthropicMessagesEndpoint('/v1/messages/count_tokens?beta=true')).toBe('count_tokens');
    expect(anthropicMessagesEndpoint('/anthropic/v1/messages?beta=true')).toBe('messages');
    expect(anthropicMessagesEndpoint('/anthropic/v1/messages/count_tokens?beta=true')).toBe('count_tokens');
    expect(anthropicMessagesEndpoint('/v1/messages/batches')).toBeNull();
    expect(anthropicMessagesEndpoint('/v1/messages-not-real')).toBeNull();
    expect(anthropicMessagesEndpoint('/anthropic-other/v1/messages')).toBeNull();
  });

  it('normalizes only the exact background-wrapper gateway prefix', () => {
    expect(normalizeAnthropicGatewayPath('/anthropic/v1/models')).toBe('/v1/models');
    expect(normalizeAnthropicGatewayPath('/anthropic/v1/models?limit=3')).toBe('/v1/models?limit=3');
    expect(normalizeAnthropicGatewayPath('/v1/models')).toBe('/v1/models');
    expect(normalizeAnthropicGatewayPath('/anthropic-other/v1/models')).toBe('/anthropic-other/v1/models');
  });

  it('estimates only input-context fields', () => {
    const base = estimateAnthropicInputTokens({
      model: 'clodex:test:model',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(base).toBeGreaterThan(0);
    expect(estimateAnthropicInputTokens({
      model: 'a-different-model',
      stream: true,
      max_tokens: 128_000,
      messages: [{ role: 'user', content: 'hello world' }],
    })).toBe(base);
  });

  it('counts images at a flat vision estimate instead of base64 bytes/4', () => {
    const data = 'A'.repeat(400_000);
    const withImage = estimateAnthropicInputTokens({
      messages: [{ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        ] },
      ] }],
    });
    // bytes/4 on the raw payload alone would be ~100k tokens
    expect(withImage).toBeLessThan(5_000);
    expect(withImage).toBeGreaterThanOrEqual(1_600);
  });

  it('runs optional optimization inside the canonical endpoint before dispatch', async () => {
    const route: ProxyRoute = {
      aliasId: 'sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'Sol',
      upstreamUrl: 'https://anthropic.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    let upstreamBody: JsonObject | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      // SAFETY: The test fixture defines the asserted runtime shape.
      upstreamBody = JSON.parse(String(init?.body)) as JsonObject;
      return new Response(JSON.stringify({
        id: 'msg_optimized',
        type: 'message',
        role: 'assistant',
        model: route.realModelId,
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    stubTestGlobal('fetch', fetchMock);
    const optimizeRequest = vi.fn(async (context) => Buffer.from(JSON.stringify({
      ...context.request,
      messages: [{ role: 'user', content: 'optimized in endpoint' }],
    })));
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      optimizeRequest,
    );

    try {
      const response = await postToProxy(
        handle.port,
        handle.token,
        {
          model: route.aliasId,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'original' }],
          stream: false,
        },
        undefined,
        '/v1/messages',
        '11111111-1111-4111-8111-111111111111',
        'agent-7',
      );

      expect(response.status).toBe(200);
      expect(optimizeRequest).toHaveBeenCalledOnce();
      expect(optimizeRequest.mock.calls[0]?.[0]).toMatchObject({
        endpoint: 'messages',
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        claudeAgentId: 'agent-7',
        route,
        processingMode: 'standard',
      });
      expect(upstreamBody).toMatchObject({
        model: route.realModelId,
        messages: [{ role: 'user', content: 'optimized in endpoint' }],
      });
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });

  it('uses per-request Claude Fast intent ahead of the launch default', async () => {
    const route: ProxyRoute = {
      aliasId: 'sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'Sol',
      upstreamUrl: 'https://anthropic.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'openai-oauth',
      authType: 'oauth',
      processingMode: 'fast',
    };
    stubTestGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_fast',
      type: 'message',
      role: 'assistant',
      model: route.realModelId,
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const optimizeRequest = vi.fn(async context => context.body);
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      optimizeRequest,
    );

    try {
      const inherited = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'launch default' }],
      });
      const disabled = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'session standard' }],
        speed: 'standard',
      });
      const enabled = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'session fast' }],
        speed: 'fast',
      });
      expect([inherited.status, disabled.status, enabled.status]).toEqual([200, 200, 200]);
      expect(optimizeRequest).toHaveBeenCalledTimes(3);
      expect(optimizeRequest.mock.calls[0]?.[0].processingMode).toBe('fast');
      expect(optimizeRequest.mock.calls[1]?.[0].processingMode).toBe('standard');
      expect(optimizeRequest.mock.calls[2]?.[0].processingMode).toBe('fast');
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });
});

describe('aliasModelId', () => {
  it('returns claude-* ids unchanged', () => {
    expect(aliasModelId('claude-sonnet-4', 'Anthropic')).toBe('claude-sonnet-4');
  });

  it('prefixes non-claude ids with anthropic-{providerId}__', () => {
    expect(aliasModelId('grok-4.6', 'xai-oauth')).toBe('anthropic-xai-oauth__grok-4.6');
  });

  it('uses stable provider id slug in alias', () => {
    expect(aliasModelId('deepseek-v4', 'go')).toBe('anthropic-go__deepseek-v4');
  });
});

describe('SDK anonymous route handling', () => {
  afterEach(() => {
    restoreTestGlobals();
  });

  it('does not reject empty upstream keys before SDK routing', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-kilo__tencent/hy3:free',
      realModelId: 'tencent/hy3:free',
      displayName: 'Tencent Hy3',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-for-test',
      baseURL: 'https://api.kilo.ai/api/gateway',
      providerId: 'kilo',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    const res = await postToProxy(handle.port, handle.token, {
      model: route.aliasId,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    handle.close();
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('Missing API key');
  });

  it('forwards anonymous Anthropic routes without authentication headers', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-local__anonymous-model',
      realModelId: 'anonymous-model',
      displayName: 'Anonymous Model',
      upstreamUrl: 'https://anonymous.example',
      apiKey: '',
      authType: 'none',
      modelFormat: 'anthropic',
      providerId: 'local',
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        id: 'msg_anonymous',
        type: 'message',
        role: 'assistant',
        model: route.realModelId,
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    stubTestGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      // SAFETY: The test fixture defines the asserted runtime shape.
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('x-api-key')).toBe(false);
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });

  it('forwards single-route anonymous messages and token counts without credential headers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/messages/count_tokens')) {
        return new Response('{"input_tokens":17}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_anonymous',
          type: 'message',
          role: 'assistant',
          model: 'anonymous-model',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    stubTestGlobal('fetch', fetchMock);

    const handle = await startProxy(
      'https://anonymous.example',
      'anonymous-model',
      false,
      undefined,
      {
        providerId: 'local',
        authType: 'none',
        modelFormat: 'anthropic',
        headers: {
          Authorization: 'Bearer configured-value',
          Cookie: 'session=configured-value',
          'X-Auth-Token': 'configured-value',
          'X-Custom': 'preserved',
        },
      },
      '',
    );

    try {
      const messages = await postToProxy(handle.port, handle.token, {
        model: 'anonymous-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const tokens = await postToProxy(handle.port, handle.token, {
        model: 'anonymous-model',
        messages: [{ role: 'user', content: 'count this' }],
      }, undefined, '/v1/messages/count_tokens');

      expect(messages.status).toBe(200);
      expect(tokens.status).toBe(200);
      expect(JSON.parse(tokens.body)).toEqual({ input_tokens: 17 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // SAFETY: The test fixture defines the asserted runtime shape.
      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
      expect(calls.map(([url]) => url)).toEqual([
        'https://anonymous.example/v1/messages',
        'https://anonymous.example/v1/messages/count_tokens',
      ]);
      for (const [, init] of calls) {
        const headers = new Headers(init.headers);
        expect(headers.has('authorization')).toBe(false);
        expect(headers.has('x-api-key')).toBe(false);
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('x-auth-token')).toBe(false);
        expect(headers.get('x-custom')).toBe('preserved');
      }
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });
});

describe('catalog model aliases', () => {
  afterEach(() => {
    restoreTestGlobals();
  });

  it('keeps aliases resolvable across an atomic catalog replacement', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:test:luna',
      realModelId: 'gpt-test-luna',
      displayName: 'Luna',
      upstreamUrl: 'https://example.test',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      providerId: 'test-provider',
    };
    const aliases = [{ name: 'luna', routeId: route.aliasId }];
    const handle = await startProxyCatalog(
      [route], route.aliasId, false, undefined, undefined, undefined, aliases,
    );
    const lookup = () => new Promise<number>((resolve, reject) => {
      http.get(
        { hostname: '127.0.0.1', port: handle.port, path: '/v1/models/luna' },
        response => { response.resume(); resolve(response.statusCode ?? 0); },
      ).on('error', reject);
    });

    try {
      expect(await lookup()).toBe(200);
      handle.replaceCatalog([{ ...route }], route.aliasId, [{ ...aliases[0]! }]);
      expect(await lookup()).toBe(200);
    } finally {
      handle.close();
    }
  });

  it('rejects unresolved configured model ids without using the default route', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    stubTestGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'missing-route', routeId: 'clodex:test:not-a-route' }],
    );

    try {
      for (const testCase of [
        { model: 'clodex:test:unavailable-model', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages' },
        { model: 'missing-route[1m]', path: '/v1/messages' },
        { model: 'missing-route[1M]', path: '/v1/messages' },
        { model: 'models/missing-route[1m]', path: '/v1/messages' },
        { model: 'models/clodex:test:unavailable-model[1M]', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages/count_tokens' },
        { model: 'models/clodex:test:unavailable-model[1M]', path: '/v1/messages/count_tokens' },
      ]) {
        const response = await postToProxy(handle.port, handle.token, {
          model: testCase.model,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }, undefined, testCase.path);

        expect(response.status, `${testCase.path} ${testCase.model}`).toBe(400);
        expect(JSON.parse(response.body)).toEqual({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `Clodex model route '${testCase.model}' is unavailable. Run \`clodex models --list\` to inspect saved routes and aliases.`,
          },
        });
        expect(response.body).not.toContain('clodex patch');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });

  it('rejects unresolved canonical ids when model aliases are not configured', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    stubTestGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
        const response = await postToProxy(handle.port, handle.token, {
          model: 'clodex:test:unavailable-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }, undefined, path);
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body).error.type).toBe('invalid_request_error');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });

  it('rejects a configured alias whose saved targets conflict instead of using the default route', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const firstRoute: ProxyRoute = {
      ...defaultRoute,
      aliasId: 'clodex:first:model-a',
      realModelId: 'model-a',
      displayName: 'Model A',
      upstreamUrl: 'https://first.example',
      providerId: 'first',
    };
    const secondRoute: ProxyRoute = {
      ...defaultRoute,
      aliasId: 'clodex:second:model-b',
      realModelId: 'model-b',
      displayName: 'Model B',
      upstreamUrl: 'https://second.example',
      providerId: 'second',
    };
    const routeByTarget = new Map([
      ['first:model-a', firstRoute],
      ['second:model-b', secondRoute],
    ]);
    const modelAliases = resolveCatalogModelAliases([
      { name: 'Orbit', providerId: 'first', modelId: 'model-a' },
      { name: 'ORBIT', providerId: 'second', modelId: 'model-b' },
    ], (providerId, modelId) => routeByTarget.get(`${providerId}:${modelId}`));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    stubTestGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog(
      [defaultRoute, firstRoute, secondRoute],
      defaultRoute.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      modelAliases,
    );

    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: 'orbit',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(400);
      // SAFETY: The test fixture defines the asserted runtime shape.
      const message = JSON.parse(response.body).error.message as string;
      expect(message).toContain('orbit');
      expect(message).toMatch(/conflict/i);
      expect(message).not.toContain('clodex patch');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });

  it('routes only the canonical alias and blocks every equivalent saved spelling', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'clodex:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const aliasRoute: ProxyRoute = {
      ...defaultRoute,
      aliasId: 'clodex:test:alias-model',
      realModelId: 'alias-model',
      displayName: 'Alias Model',
      upstreamUrl: 'https://alias.example',
    };
    const modelAliases = resolveCatalogModelAliases([
      { name: 'LuNa', providerId: 'test-provider', modelId: 'alias-model' },
      { name: 'LUNA', providerId: 'test-provider', modelId: 'alias-model' },
    ], (_providerId, modelId) => (
      modelId === 'alias-model' ? aliasRoute : undefined
    ));
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ type: 'message', model: 'alias-model' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    stubTestGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog(
      [defaultRoute, aliasRoute],
      defaultRoute.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      modelAliases,
    );

    try {
      const canonical = await postToProxy(handle.port, handle.token, {
        model: 'luna',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      expect(canonical.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      for (const savedName of ['LuNa', 'LUNA']) {
        const blocked = await postToProxy(handle.port, handle.token, {
          model: savedName,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        });
        expect(blocked.status, savedName).toBe(400);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });

  it('routes alias names to their target route without rewriting the requested model id', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'anthropic-test-provider__default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const providers: LocalProvider[] = [{
      id: 'Test-Provider',
      name: 'Test Provider',
      apiKey: 'provider-key',
      models: [{
        id: 'Solver-V1',
        name: 'Solver V1',
        family: 'test',
        brand: 'Other',
        modelFormat: 'anthropic',
        upstreamModelId: 'Solver-V1',
        baseUrl: 'https://upstream-solver.example',
        contextWindow: 1_000_000,
      }],
    }];
    const savedAliases: ModelAlias[] = [{
      name: 'sol',
      providerId: 'Test-Provider',
      modelId: 'Solver-V1',
    }];
    const resolveRoute = makeRouteResolver(providers);
    const aliasTarget = resolveRoute('Test-Provider', 'Solver-V1');
    const modelAliases = resolveCatalogModelAliases(savedAliases, resolveRoute);
    expect(aliasTarget?.aliasId).toBe('anthropic-test-provider__Solver-V1[1m]');
    expect(modelAliases).toEqual([{
      name: 'sol',
      routeId: 'anthropic-test-provider__Solver-V1[1m]',
    }]);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'solver-v1', content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    stubTestGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog(
      [defaultRoute, aliasTarget!],
      defaultRoute.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      modelAliases,
    );

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: 'sol',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      // Resolved to the alias target (not the default route's missing SDK → 502)
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      // SAFETY: The test fixture defines the asserted runtime shape.
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('upstream-solver.example');
      // SAFETY: The test fixture defines the asserted runtime shape.
      expect(JSON.parse(init.body as string).model).toBe('Solver-V1');

      // Both foreground and background-wrapper discovery paths resolve.
      for (const path of [
        '/v1/models',
        '/anthropic/v1/models',
        '/v1/models/sol',
        '/anthropic/v1/models/sol',
      ]) {
        const modelLookup = await new Promise<number>((resolve, reject) => {
          http.get(
            { hostname: '127.0.0.1', port: handle.port, path },
            res2 => { res2.resume(); resolve(res2.statusCode ?? 0); },
          ).on('error', reject);
        });
        expect(modelLookup).toBe(200);
      }

      const prefixedMessages = await postToProxy(handle.port, handle.token, {
        model: 'sol',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'background wrapper' }],
        stream: false,
      }, undefined, '/anthropic/v1/messages');
      expect(prefixedMessages.status).toBe(200);
    } finally {
      handle.close();
    }
  });

  it('ignores aliases whose target route is absent', async () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'ghost', routeId: 'clodex:test:not-a-route' }],
    );

    try {
      const status = await new Promise<number>((resolve, reject) => {
        http.get(
          { hostname: '127.0.0.1', port: handle.port, path: '/v1/models/ghost' },
          res2 => { res2.resume(); resolve(res2.statusCode ?? 0); },
        ).on('error', reject);
      });
      expect(status).toBe(404);
    } finally {
      handle.close();
    }
  });
});

describe('token counting', () => {
  it('returns a local estimate for translated OAuth routes before resolving credentials', async () => {
    const refreshToken = vi.fn(async () => {
      throw new Error('credential resolution must not run for local token counts');
    });
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
      authType: 'oauth',
      refreshToken,
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count this context locally' }],
      }, undefined, '/v1/messages/count_tokens?beta=true');

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ input_tokens: expect.any(Number) });
      expect(JSON.parse(res.body).input_tokens).toBeGreaterThan(0);
      expect(refreshToken).not.toHaveBeenCalled();
    } finally {
      handle.close();
    }
  });

  it('forwards native Anthropic token counts with the real upstream model id', async () => {
    const fetchMock = vi.fn(async () => new Response('{"input_tokens":17}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    stubTestGlobal('fetch', fetchMock);
    const route: ProxyRoute = {
      aliasId: 'clodex:anthropic:sonnet',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count upstream' }],
      }, undefined, '/v1/messages/count_tokens');

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ input_tokens: 17 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages/count_tokens',
        expect.objectContaining({
          body: expect.stringContaining('"model":"claude-sonnet-4-6"'),
        }),
      );
    } finally {
      handle.close();
      restoreTestGlobals();
    }
  });
});

describe('translated request cancellation', () => {
  it('observes a downstream abort and records translation cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-cancel-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let upstreamReceivedResolve!: () => void;
    const upstreamReceived = new Promise<void>(resolve => { upstreamReceivedResolve = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        upstreamReceivedResolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const previousKeepAlive = process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
    process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = '50';
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const payload = JSON.stringify({
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'cancel this request' }],
        stream: true,
      });
      const controller = new AbortController();
      const request = http.request({
        hostname: '127.0.0.1',
        port: handle.port,
        path: '/v1/messages',
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${handle.token}`,
          'Content-Length': Buffer.byteLength(payload),
          'x-relay-request-id': 'req-cancel-1',
          'x-claude-code-agent-id': 'workflow-cancel-1',
        },
      });
      request.on('error', () => {});
      let downstreamBody = '';
      let responseStartedResolve!: () => void;
      const responseStarted = new Promise<void>(resolve => { responseStartedResolve = resolve; });
      request.on('response', response => {
        responseStartedResolve();
        response.on('data', chunk => { downstreamBody += chunk.toString(); });
      });
      request.end(payload);
      await upstreamReceived;
      await responseStarted;
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(downstreamBody).toContain('event: ping');
      controller.abort();

      await waitForCondition(async () => {
        const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
        expect(entries).toContainEqual(expect.objectContaining({
          event: 'translation_cancelled',
          requestId: 'req-cancel-1',
          phase: 'translating',
          cancellationReason: 'downstream_client_abort',
        }));
        expect(entries.some(entry => entry.event === 'translation_failed')).toBe(false);
        expect(entries.some(entry => entry.event === 'upstream_error')).toBe(false);
      });
      const pingsAfterAbort = downstreamBody.split('event: ping').length - 1;
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(downstreamBody.split('event: ping').length - 1).toBe(pingsAfterAbort);
    } finally {
      if (previousKeepAlive === undefined) delete process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
      else process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = previousKeepAlive;
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

it('returns an HTTP error when request translation throws instead of leaving the client pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-translation-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'http://127.0.0.1:1/v1',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: {},
        stream: true,
      }, 'req-translate-error');

      expect(res.status).toBe(502);
      expect(res.body).toContain('error');
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-translate-error',
        phase: 'preparing_translation',
        sdkParts: 0,
        translatedBytes: 0,
      }));
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a pre-stream HTTP failure and logs the AI SDK response body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ error: { message: 'translated request rejected', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }, 'req-error-1');

      expect(res.status).toBe(400);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(res.body).toContain('translated request rejected');
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      const errorEntry = entries.find(entry => entry.event === 'upstream_error');
      expect(errorEntry).toMatchObject({
        event: 'upstream_error',
        requestId: 'req-error-1',
        modelId: route.aliasId,
        provider: 'test-provider',
        route: 'translated',
        statusCode: 400,
        isRetryable: false,
        attemptCount: 1,
      });
      expect(errorEntry.errorContent).toContain('translated request rejected');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-error-1',
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_started',
        requestId: 'req-error-1',
        lastPartType: 'start',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-error-1',
        lastPartType: 'error',
      }));
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('returns HTTP 429 with a clamped retry-after header after upstream rate limiting', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(429, {
        'Content-Type': 'application/json',
        // retry-after-ms drives the AI SDK's internal backoff (1ms keeps the
        // SDK's own retries fast); retry-after is what clodex forwards to the
        // client, and 3600 must come out clamped to 60.
        'retry-after-ms': '1',
        'retry-after': '3600',
        'Connection': 'close',
      });
      res.end(JSON.stringify({ error: { message: 'rate limited, slow down', type: 'rate_limit_error' } }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:rate-limited-model',
      realModelId: 'rate-limited-model',
      displayName: 'Rate Limited Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.body).toContain('rate limited');
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);

  it('records the bounded WebSocket transport code in the translation lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-transport-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Connection': 'close',
      });
      res.end(JSON.stringify({
        error: {
          type: 'transport_error',
          code: 'websocket_transport_error',
          message: 'transport unavailable',
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'gpt-5.6-test',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'test transport failure' }],
        stream: true,
      }, 'req-transport-error');

      expect(res.status).toBe(400);
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-transport-error',
        errorCode: 'websocket_transport_error',
        partialResponse: false,
        replaySafe: true,
        recoveryAction: 'none',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        requestId: 'req-transport-error',
        partialResponse: false,
        replaySafe: true,
        recoveryAction: 'none',
      }));
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    ['workflow agent', 'workflow-agent-retry'],
    ['subagent', 'subagent-retry'],
  ])('buffers and safely retries a partial transport failure for a %s', async (_label, agentId) => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-agent-retry-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        if (requestCount === 1) {
          res.write('data: {"id":"discarded","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"discarded partial output"},"finish_reason":null}]}\n\n');
          res.end('data: {"error":{"type":"transport_error","code":"websocket_transport_error","message":"connection ended"}}\n\n');
          return;
        }
        res.write('data: {"id":"recovered","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"recovered output"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"recovered","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'recover this agent turn' }],
        stream: true,
      }, `req-${agentId}`, '/v1/messages',
      '11111111-1111-4111-8111-111111111111', agentId);

      expect(requestCount).toBe(2);
      expect(res.status).toBe(200);
      expect(res.body).toContain('recovered output');
      expect(res.body).not.toContain('discarded partial output');
      expect(res.body).not.toContain('event: error');
      expect(res.body).toContain('event: message_stop');
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries.some(entry => entry.event === 'translation_failed')).toBe(false);
      expect(entries.some(entry => entry.event === 'upstream_error')).toBe(false);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_retrying',
        requestId: `req-${agentId}`,
        retryAttempt: 1,
        retryLimit: 2,
        discardedBytes: expect.any(Number),
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_completed',
        requestId: `req-${agentId}`,
      }));
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('buffers and safely retries a partial transport failure for the main agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-partial-transport-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        if (requestCount === 1) {
          res.write('data: {"id":"chatcmpl-partial","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"discarded partial output"},"finish_reason":null}]}\n\n');
          res.end('data: {"error":{"type":"transport_error","code":"websocket_transport_error","message":"connection ended"}}\n\n');
          return;
        }
        res.write('data: {"id":"chatcmpl-recovered","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"recovered main output"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"chatcmpl-recovered","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'stream then fail' }],
        stream: true,
      }, 'req-partial-transport', '/v1/messages',
      '11111111-1111-4111-8111-111111111111');

      expect(requestCount).toBe(2);
      expect(res.status).toBe(200);
      expect(res.body).toContain('recovered main output');
      expect(res.body).not.toContain('discarded partial output');
      expect(res.body).not.toContain('event: error');
      expect(res.body).toContain('event: message_stop');
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_retrying',
        requestId: 'req-partial-transport',
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        retryAttempt: 1,
        retryLimit: 2,
        discardedBytes: expect.any(Number),
      }));
      expect(entries.some(entry => entry.event === 'translation_failed')).toBe(false);
      expect(entries.some(entry => entry.event === 'upstream_error')).toBe(false);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('streams SuperGrok output before the upstream response completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-xai-live-stream-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let releaseUpstream!: () => void;
    const upstreamRelease = new Promise<void>(resolve => { releaseUpstream = resolve; });
    let upstreamCompleted = false;
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', async () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        res.write('data: {"id":"grok-live","object":"chat.completion.chunk","created":1,"model":"grok-4.6","choices":[{"index":0,"delta":{"role":"assistant","content":"visible before completion"},"finish_reason":null}]}\n\n');
        await upstreamRelease;
        res.write('data: {"id":"grok-live","object":"chat.completion.chunk","created":1,"model":"grok-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
        upstreamCompleted = true;
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'grok',
      realModelId: 'grok-4.6',
      displayName: 'Grok 4.6',
      upstreamUrl: '',
      apiKey: 'subscription-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'xai-oauth',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      let visibleOutput = '';
      const completed = postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'stream live' }],
        stream: true,
      }, 'req-xai-live', '/v1/messages', undefined, undefined, chunk => { visibleOutput += chunk; });

      await waitForCondition(() => visibleOutput.includes('visible before completion'));
      expect(upstreamCompleted).toBe(false);
      releaseUpstream();

      const response = await completed;
      expect(response.status).toBe(200);
      expect(response.body).toContain('visible before completion');
      expect(response.body).toContain('event: message_stop');
    } finally {
      releaseUpstream();
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not replay SuperGrok after live output is visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-xai-live-failure-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        res.write('data: {"id":"grok-partial","object":"chat.completion.chunk","created":1,"model":"grok-4.6","choices":[{"index":0,"delta":{"role":"assistant","content":"one visible answer"},"finish_reason":null}]}\n\n');
        res.end('data: {"error":{"type":"transport_error","code":"websocket_transport_error","message":"connection ended"}}\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'grok',
      realModelId: 'grok-4.6',
      displayName: 'Grok 4.6',
      upstreamUrl: '',
      apiKey: 'subscription-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'xai-oauth',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'fail after live output' }],
        stream: true,
      }, 'req-xai-live-failure');

      expect(requestCount).toBe(1);
      expect(response.status).toBe(200);
      expect(response.body).toContain('one visible answer');
      expect(response.body).toContain('event: error');
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-xai-live-failure',
        partialResponse: true,
        replaySafe: false,
      }));
      expect(entries.some(entry => entry.event === 'translation_retrying')).toBe(false);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not retry a non-retryable workflow error or expose its buffered output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-partial-terminal-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        res.write('data: {"id":"chatcmpl-terminal","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"partial output"},"finish_reason":null}]}\n\n');
        res.end('data: {"error":{"type":"invalid_request_error","code":"invalid_prompt","message":"request cannot be retried (HTTP 400)"}}\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'stream then reject' }],
        stream: true,
      }, 'req-partial-terminal', '/v1/messages',
      '44444444-4444-4444-8444-444444444444', 'workflow-terminal');

      expect(requestCount).toBe(1);
      expect(res.status).toBe(400);
      expect(res.body).not.toContain('partial output');
      expect(JSON.parse(res.body)).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
      });
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        requestId: 'req-partial-terminal',
        isRetryable: false,
        partialResponse: false,
        replaySafe: true,
        recoveryAction: 'none',
      }));
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('retries a buffered workflow tool call without exposing the failed attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-agent-tool-retry-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        const failed = requestCount === 1;
        const name = failed ? 'DiscardedTool' : 'FinalTool';
        const id = failed ? 'call_discarded' : 'call_final';
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-${id}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'translated-model',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0, id, type: 'function',
                function: { name, arguments: '{"value":true}' },
              }],
            },
            finish_reason: null,
          }],
        })}\n\n`);
        if (failed) {
          res.end('data: {"error":{"type":"transport_error","code":"websocket_transport_error","message":"connection ended"}}\n\n');
          return;
        }
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-${id}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'translated-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'call one tool safely' }],
        tools: [{ name: 'FinalTool', description: 'Final tool', input_schema: { type: 'object' } }],
        stream: true,
      }, 'req-workflow-tool-retry', '/v1/messages',
      '22222222-2222-4222-8222-222222222222', 'workflow-tool-retry');

      expect(requestCount).toBe(2);
      expect(res.status).toBe(200);
      expect(res.body).toContain('FinalTool');
      expect(res.body).not.toContain('DiscardedTool');
      expect(res.body.split('"type":"tool_use"')).toHaveLength(2);
      expect(res.body).not.toContain('event: error');
      expect(res.body).toContain('event: message_stop');
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries.some(entry => entry.event === 'translation_failed')).toBe(false);
      expect(entries.some(entry => entry.event === 'upstream_error')).toBe(false);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('exhausts bounded retries without exposing a partial subagent tool call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-partial-tool-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      requestCount += 1;
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        res.write('data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_probe","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"echo"}}]},"finish_reason":null}]}\n\n');
        res.end('data: {"error":{"type":"transport_error","code":"websocket_transport_error","message":"connection ended"}}\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'call a tool then fail' }],
        tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } }],
        stream: true,
      }, 'req-partial-tool', '/v1/messages',
      '22222222-2222-4222-8222-222222222222', 'subagent-tool-1');

      expect(requestCount).toBe(3);
      expect(res.status).toBe(502);
      expect(res.body).not.toContain('"type":"tool_use"');
      expect(JSON.parse(res.body)).toMatchObject({
        type: 'error',
        error: { type: 'api_error' },
      });
      expect(res.body).not.toContain('"type":"message_stop"');
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        requestId: 'req-partial-tool',
        claudeAgentId: 'subagent-tool-1',
        isRetryable: true,
        partialResponse: false,
        replaySafe: true,
        recoveryAction: 'client_retry_request',
      }));
      expect(entries.filter(entry => entry.event === 'translation_retrying')).toHaveLength(2);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('translates an OpenAI context overflow into an Anthropic prompt-too-long error', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        error: {
          message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:small-context',
      realModelId: 'small-context',
      displayName: 'Small Context Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
      contextWindow: 10,
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'This prompt is too long.' }],
        stream: true,
      }, 'req-context-overflow');

      expect(res.status).toBe(400);
      // SAFETY: The test fixture defines the asserted runtime shape.
      const body = JSON.parse(res.body) as {
        type: string;
        error: { type: string; message: string };
        request_id: string;
      };
      expect(body).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
        request_id: 'req-context-overflow',
      });
      expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > 10 maximum$/);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);

  it('logs SDK input and translated output through successful stream completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-success-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
      res.end([
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const requestBody = {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      };
      const countResponse = await postToProxy(
        handle.port,
        handle.token,
        requestBody,
        undefined,
        '/v1/messages/count_tokens',
      );
      const expectedInputTokens = JSON.parse(countResponse.body).input_tokens;
      const claudeSessionId = '00000000-0000-4000-8000-000000000003';
      const res = await postToProxy(
        handle.port,
        handle.token,
        requestBody,
        'req-success-1',
        '/v1/messages',
        claudeSessionId,
      );

      expect(res.status).toBe(200);
      expect(res.body).toContain('event: message_stop');
      const messageStartBlock = res.body
        .split('\n\n')
        .find(block => block.startsWith('event: message_start'))!;
      const messageStart = JSON.parse(messageStartBlock.split('\n')[1]!.replace('data: ', ''));
      expect(messageStart.message.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      const messageDeltaBlock = res.body
        .split('\n\n')
        .find(block => block.startsWith('event: message_delta'))!;
      const messageDelta = JSON.parse(messageDeltaBlock.split('\n')[1]!.replace('data: ', ''));
      expect(messageDelta.usage).toEqual({
        input_tokens: expectedInputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-success-1',
        claudeSessionId,
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_started',
        requestId: 'req-success-1',
        claudeSessionId,
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_completed',
        requestId: 'req-success-1',
        claudeSessionId,
        lastPartType: 'finish',
      }));
      const completed = entries.find(entry => entry.event === 'translation_completed');
      expect(completed.sdkParts).toBeGreaterThan(0);
      expect(completed.translatedBytes).toBeGreaterThan(0);
      expect(completed.translatedChunks).toBeGreaterThan(0);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a buffered workflow agent alive until its complete response commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-keepalive-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    // A tool call whose arguments stream as many small deltas over ~800ms. The
    // adapter buffers every tool-input-delta and only flushes input_json_delta at
    // completion, so nothing is written downstream during that window — the exact
    // shape that tripped Claude Code's ~180s read-idle abort in production.
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(openAiSseChunk(
          { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'myTool', arguments: '{"v":"' } }] },
          null,
        ));
        let emitted = 0;
        const argTimer = setInterval(() => {
          emitted += 1;
          if (emitted <= 32) {
            res.write(openAiSseChunk({ tool_calls: [{ index: 0, function: { arguments: 'a' } }] }, null));
            return;
          }
          clearInterval(argTimer);
          res.write(openAiSseChunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, null));
          res.write(openAiSseChunk({}, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          res.end();
        }, 25);
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const prevKeepAlive = process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
    process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = '100';
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'call a tool with a big argument' }],
        stream: true,
      }, 'req-keepalive-1', '/v1/messages',
      '33333333-3333-4333-8333-333333333333', 'workflow-keepalive');

      expect(res.status).toBe(200);
      // At least one ping must have been injected during the buffering window.
      const pingCount = res.body.split('event: ping').length - 1;
      expect(pingCount).toBeGreaterThanOrEqual(1);
      // The real tool input must still flush intact once the call completes, and
      // pings must not corrupt the surrounding SSE framing.
      expect(res.body).toContain('input_json_delta');
      expect(res.body).toContain('event: message_stop');
      // Pings are written to the wire but deliberately bypass onOutput, so they
      // are NOT counted in translation accounting: every real SSE frame carries
      // one `event:` line, and the surplus over translatedChunks is exactly the
      // pings — keeping diagnostic outputIdleMs honest about real buffering.
      const totalEventFrames = res.body.split('event: ').length - 1;
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      const completed = entries.find(entry => entry.event === 'translation_completed');
      expect(completed?.lastPartType).toBe('finish');
      expect(totalEventFrames - completed.translatedChunks).toBe(pingCount);
    } finally {
      if (prevKeepAlive === undefined) delete process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
      else process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = prevKeepAlive;
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a pre-output compaction-style wait alive beyond the client idle boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-pre-output-keepalive-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
          res.end([
            'data: {"id":"delayed","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}',
            '',
            'data: {"id":"delayed","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'));
        }, 350);
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:delayed-model',
      realModelId: 'translated-model',
      displayName: 'Delayed Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const previousKeepAlive = process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
    process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = '50';
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'wait through native compaction' }],
        stream: true,
      }, 'req-pre-output-keepalive', '/v1/messages',
      '44444444-4444-4444-8444-444444444444', 'workflow-compaction-wait');

      expect(response.status).toBe(200);
      const pingCount = response.body.split('event: ping').length - 1;
      expect(pingCount).toBeGreaterThanOrEqual(5);
      expect(response.body).toContain('event: message_stop');
      const messageDeltaBlock = response.body
        .split('\n\n')
        .find(block => block.startsWith('event: message_delta'))!;
      const messageDelta = JSON.parse(messageDeltaBlock.split('\n')[1]!.replace('data: ', ''));
      expect(messageDelta.usage.input_tokens).toBeGreaterThan(0);
      const entries = (await readFlushedLog(inferenceLogPath))
        .trim().split('\n').map(line => JSON.parse(line));
      const completed = entries.find(entry => entry.event === 'translation_completed');
      expect(completed).toMatchObject({
        requestId: 'req-pre-output-keepalive',
        lastPartType: 'finish',
      });
      expect(completed.translatedChunks).toBeGreaterThan(0);
      expect(entries.some(entry => entry.event === 'translation_cancelled')).toBe(false);
    } finally {
      if (previousKeepAlive === undefined) delete process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS;
      else process.env.CLODEX_STREAM_KEEPALIVE_INTERVAL_MS = previousKeepAlive;
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('logs dispatch and completion for a non-streaming translated request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-sdk-nonstream-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        id: 'chatcmpl-nonstream',
        object: 'chat.completion',
        created: 1,
        model: 'translated-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = requireTcpAddress(upstream.address(), 'test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }, 'req-nonstream-1');

      expect(res.status).toBe(200);
      const entries = (await readFlushedLog(inferenceLogPath)).trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-nonstream-1',
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_completed',
        requestId: 'req-nonstream-1',
        phase: 'waiting_for_sdk',
      }));
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

describe('anthropic passthrough debug logging', () => {
  afterEach(() => {
    restoreTestGlobals();
    vi.clearAllMocks();
  });

  it('logs upstream non-OK status and body', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      providerData: {},
    };

    stubTestGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, true);
    const res = await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    handle.close();
    expect(res.status).toBe(429);
    const log = await readFlushedLog(getProxyDebugLogPath());
    expect(log).toContain('anthropic upstream 429');
    expect(log).toContain('rate limit exceeded');
  });

  it('forwards matching Claude Code OAuth session id in body metadata and header', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      providerData: {
        cliUserID: 'a'.repeat(64),
        accountUUID: '11111111-1111-4111-8111-111111111111',
      },
    };

    stubTestGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, true);
    await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    handle.close();
    const [, init] = asMocked(fetch).mock.calls[0]!;
    // SAFETY: The test fixture defines the asserted runtime shape.
    const headers = init?.headers as Record<string, string>;
    // SAFETY: The test fixture defines the asserted runtime shape.
    const body = JSON.parse(String(init?.body)) as { metadata?: { user_id?: string } };
    // SAFETY: The test fixture defines the asserted runtime shape.
    const userId = JSON.parse(body.metadata!.user_id!) as { session_id: string };
    expect(headers['X-Claude-Code-Session-Id']).toBe(userId.session_id);
  });

  it('prepends Claude Code OAuth billing line to upstream system prompt', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      providerData: {
        cliUserID: 'a'.repeat(64),
        accountUUID: '11111111-1111-4111-8111-111111111111',
      },
    };

    stubTestGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ type: 'message', content: [] }),
      text: async () => JSON.stringify({ type: 'message', content: [] }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, false);
    await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    handle.close();
    const [, init] = asMocked(fetch).mock.calls[0]!;
    // SAFETY: The test fixture defines the asserted runtime shape.
    const body = JSON.parse(String(init?.body)) as { system?: Array<{ type: string; text: string }> };
    expect(body.system?.[0]?.text).toBe('x-anthropic-billing-header: cc_version=2.1.195.0; cc_entrypoint=cli;');
    expect(body.system?.[1]?.text).toBe('You are helpful.');
  });
});

describe('OAuth route credential resolution', () => {
  afterEach(() => {
    restoreTestGlobals();
    vi.clearAllMocks();
  });

  it('passes Claude compact requests through to the Responses transport context', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-oauth-provider__gpt-3-5-turbo-compact',
      realModelId: 'gpt-3.5-turbo-compact',
      displayName: 'OAuth Compact Route',
      upstreamUrl: '',
      apiKey: 'oauth-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'oauth-provider',
      authType: 'oauth',
      refreshToken: vi.fn(async () => 'oauth-token'),
    };
    // SAFETY: The test fixture defines the asserted runtime shape.
    asMocked(withResponsesWebSocketDiagnosticContext).mockReturnValueOnce({
      id: 'msg-compact',
      type: 'message',
      role: 'assistant',
      model: route.realModelId,
      content: [{ type: 'text', text: 'summary' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
            'Summarize the conversation.',
            'REMINDER: Do NOT call any tools. Respond with plain text only',
          ].join('\n'),
        }],
        stream: false,
      });

      expect(response.status).toBe(200);
      expect(withResponsesWebSocketDiagnosticContext).toHaveBeenCalledWith(
        expect.objectContaining({
          estimatedInputTokens: expect.any(Number),
          forceCompaction: true,
        }),
        expect.any(Function),
      );
    } finally {
      handle.close();
    }
  });

  it('resolves the current token before dispatch and updates the route cache', async () => {
    const refreshToken = vi.fn(async () => 'fresh-oauth-token');
    const route: ProxyRoute = {
      aliasId: 'claude-oauth-route',
      realModelId: 'claude-oauth-route',
      displayName: 'OAuth Route',
      upstreamUrl: 'https://api.example.test',
      apiKey: 'stale-oauth-token',
      modelFormat: 'anthropic',
      providerId: 'oauth-provider',
      authType: 'oauth',
      providerData: {},
      refreshToken,
    };
    stubTestGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ type: 'message', content: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(200);
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(route.apiKey).toBe('fresh-oauth-token');
      const [, init] = asMocked(fetch).mock.calls[0]!;
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fresh-oauth-token',
      );
    } finally {
      handle.close();
    }
  });

  it('rebuilds the translated SDK route and retries once after an OAuth 401', async () => {
    const refreshToken = vi.fn(async (rejectedAccessToken?: string) =>
      rejectedAccessToken === undefined
        ? 'rejected-oauth-token'
        : 'fresh-oauth-token',
    );
    const route: ProxyRoute = {
      aliasId: 'anthropic-oauth-provider__gpt-3-5-turbo-instruct',
      realModelId: 'gpt-3.5-turbo-instruct',
      displayName: 'OAuth Retry Route',
      upstreamUrl: '',
      apiKey: 'launch-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'oauth-provider',
      authType: 'oauth',
      refreshToken,
    };
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization');
        if (authorization === 'Bearer rejected-oauth-token') {
        return new Response(
            JSON.stringify({ error: { message: 'expired token' } }),
            {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
          return new Response(
          [
            'data: {"id":"chatcmpl-retry","object":"chat.completion.chunk","created":1,"model":"gpt-3.5-turbo-instruct","choices":[{"index":0,"delta":{"role":"assistant","content":"recovered"},"finish_reason":null}]}',
            'data: {"id":"chatcmpl-retry","object":"chat.completion.chunk","created":1,"model":"gpt-3.5-turbo-instruct","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        );
      },
    );
    stubTestGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('recovered');
      expect(refreshToken).toHaveBeenNthCalledWith(1);
      expect(refreshToken).toHaveBeenNthCalledWith(2, 'rejected-oauth-token');
      expect(route.apiKey).toBe('fresh-oauth-token');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.map(([, init]) =>
          new Headers(init?.headers).get('authorization'),
        ),
      ).toEqual(['Bearer rejected-oauth-token', 'Bearer fresh-oauth-token']);
    } finally {
      handle.close();
    }
  });

  it('surfaces a second translated OAuth 401 without another retry', async () => {
    const refreshToken = vi.fn(async (rejectedAccessToken?: string) =>
      rejectedAccessToken === undefined
        ? 'rejected-oauth-token'
        : 'fresh-oauth-token',
    );
    const route: ProxyRoute = {
      aliasId: 'anthropic-oauth-provider__gpt-3-5-turbo-second-401',
      realModelId: 'gpt-3.5-turbo-instruct',
      displayName: 'OAuth Second 401 Route',
      upstreamUrl: '',
      apiKey: 'launch-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'oauth-provider',
      authType: 'oauth',
      refreshToken,
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'expired token' } }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    stubTestGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(refreshToken).toHaveBeenCalledTimes(2);
      expect(route.apiKey).toBe('fresh-oauth-token');
    } finally {
      handle.close();
    }
  });

  it('refuses to retry a translated OAuth 401 with an unchanged token', async () => {
    const refreshToken = vi.fn(async (rejectedAccessToken?: string) =>
      rejectedAccessToken ?? 'rejected-oauth-token',
    );
    const route: ProxyRoute = {
      aliasId: 'anthropic-oauth-provider__gpt-3-5-turbo-unchanged',
      realModelId: 'gpt-3.5-turbo-instruct',
      displayName: 'OAuth Unchanged Token Route',
      upstreamUrl: '',
      apiKey: 'launch-token',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'oauth-provider',
      authType: 'oauth',
      refreshToken,
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'expired token' } }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    stubTestGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(response.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(refreshToken).toHaveBeenCalledTimes(2);
      expect(route.apiKey).toBe('rejected-oauth-token');
    } finally {
      handle.close();
    }
  });
});
