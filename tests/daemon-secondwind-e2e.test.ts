import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { DaemonInferenceCollector } from '../src/daemon/collector.js';
import { daemonControlRequest } from '../src/daemon/control-client.js';
import { startDaemonControlApi } from '../src/daemon/control-api.js';
import { DaemonMetricsStore } from '../src/daemon/metrics.js';
import { createDaemonRuntimeState } from '../src/daemon/runtime.js';
import { SecondwindService } from '../src/daemon/secondwind.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy/index.js';
import type { JsonObject } from './test-helpers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function toolRequest(content: string): JsonObject {
  return {
    model: 'sol',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content,
      }],
    }],
    stream: false,
  };
}

function postMessage(
  port: number,
  token: string,
  body: JsonObject,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-api-key': token,
        'x-relay-request-id': 'secondwind-e2e-request',
        'x-claude-code-session-id': '11111111-1111-4111-8111-111111111111',
        'x-claude-code-agent-id': 'workflow-agent-1',
      },
    }, response => {
      let responseBody = '';
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: responseBody,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

describe('single-endpoint daemon Secondwind integration', () => {
  it('toggles rewriting on the same endpoint used by Claude and reports it over control', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-secondwind-e2e-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const upstreamBodies: JsonObject[] = [];
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        // SAFETY: The test fixture defines the asserted runtime shape.
        upstreamBodies.push(await request.json() as JsonObject);
        return Response.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5.6-sol',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const rewrite = vi.fn(() => ({
      request: toolRequest('compacted by Secondwind'),
      stats: {
        blocks_rewritten: 1,
        input_tokens: 1_503,
        output_tokens: 771,
        tokens_saved: 732,
      },
    }));
    const metrics = new DaemonMetricsStore(join(root, 'metrics.sqlite'));
    const secondwind = new SecondwindService({
      initialMode: 'on',
      metrics,
      createSession: async () => ({ rewrite, close: () => {} }),
    });
    const route: ProxyRoute = {
      aliasId: 'sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'Sol',
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
      apiKey: 'upstream-key',
      modelFormat: 'anthropic',
      providerId: 'test-provider',
    };
    const endpoint = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      context => secondwind.rewrite({
        requestId: context.requestId,
        body: context.body,
        request: context.request,
        sessionId: context.claudeSessionId
          ? `${context.claudeSessionId}:${context.claudeAgentId ?? 'parent'}`
          : undefined,
        reportingSessionId: context.claudeSessionId,
        modelId: context.route.realModelId,
        processingMode: context.processingMode,
        recordMetrics: context.endpoint === 'messages',
      }),
    );
    const collector = new DaemonInferenceCollector(metrics);
    const runtime = createDaemonRuntimeState({
      pid: process.pid,
      bunPath: process.execPath,
      cliPath: '/tmp/clodex/cli.js',
      ready: true,
      port: endpoint.port,
      controlSocketPath: socketPath,
      version: 'test',
    });
    const control = await startDaemonControlApi({
      socketPath,
      runtime,
      collector,
      accounts: {
        list: () => [],
        select: () => {},
        createLaunchTicket: () => null,
      },
      secondwind,
      models: {
        snapshot: () => ({ models: [] }),
        setEnabled: async () => ({ models: [] }),
      },
      requestRestart: () => {},
      requestStop: () => {},
    });

    try {
      const original = toolRequest('large tool output '.repeat(1_000));
      expect((await postMessage(endpoint.port, endpoint.token, original)).status).toBe(200);
      expect(upstreamBodies[0]).toMatchObject({
        model: route.realModelId,
        messages: [{
          content: [{
            content: 'compacted by Secondwind',
          }],
        }],
      });
      expect(rewrite).toHaveBeenCalledOnce();
      secondwind.handleTrace({
        kind: 'lifecycle',
        entry: {
          event: 'response_usage',
          requestId: 'secondwind-e2e-request',
          modelId: route.realModelId,
          provider: route.providerId!,
          route: 'translated',
          inputTokens: 100,
          cacheReadInputTokens: 700,
          outputTokens: 1,
        },
      });
      secondwind.handleTrace({
        kind: 'lifecycle',
        entry: {
          event: 'response_completed',
          requestId: 'secondwind-e2e-request',
          modelId: route.realModelId,
          provider: route.providerId!,
          route: 'translated',
        },
      });

      const active = await daemonControlRequest<{
        mode: string;
        loaded: boolean;
        sessions: number;
        applied: {
          requests: number;
          blocksRewritten: number;
          tokensReduced: number;
          estimatedTokenRequests: number;
        };
        lifetime: {
          requests: number;
          blocksRewritten: number;
          inputTokensConsidered: number;
          tokensReduced: number;
        };
        topSessions: unknown[];
      }>('/v1/secondwind', { socketPath });
      expect(active).toMatchObject({
        mode: 'on',
        loaded: true,
        sessions: 0,
        applied: {
          requests: 1,
          blocksRewritten: 1,
          inputTokensConsidered: 1_503,
          tokensReduced: 732,
          estimatedTokenRequests: 0,
        },
        lifetime: {
          requests: 1,
          blocksRewritten: 1,
          tokensReduced: 732,
        },
      });
      expect(active.topSessions).toHaveLength(1);
      expect(metrics.secondwindLifetime()).toMatchObject({
        requests: 1,
        blocksRewritten: 1,
        inputTokensConsidered: 1_503,
        tokensReduced: 732,
      });

      await daemonControlRequest('/v1/secondwind/mode', {
        socketPath,
        method: 'POST',
        body: { mode: 'off' },
      });
      expect((await postMessage(endpoint.port, endpoint.token, original)).status).toBe(200);
      expect(upstreamBodies[1]).toMatchObject({
        model: route.realModelId,
        messages: [{
          content: [{
            content: 'large tool output '.repeat(1_000),
          }],
        }],
      });
      expect(rewrite).toHaveBeenCalledOnce();

      expect(await daemonControlRequest('/v1/status', { socketPath }))
        .toMatchObject({ running: true, port: endpoint.port });
    } finally {
      await control.close();
      endpoint.close();
      secondwind.close();
      metrics.close();
      await upstream.stop(true);
    }
  });
});
