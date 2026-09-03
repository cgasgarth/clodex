import { describe, expect, it, vi } from 'bun:test';
import { estimateApiCost } from '../src/daemon/api-pricing.js';
import { hashSessionId } from '../src/daemon/metrics.js';
import { SecondwindService } from '../src/daemon/secondwind.js';
import type { JsonObject } from './test-helpers.js';

function toolRequest(content: string): JsonObject {
  return {
    model: 'sol',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content,
      }],
    }],
  };
}

describe('Secondwind daemon service', () => {
  it('defaults to on and loads the optimizer', async () => {
    const createSession = vi.fn(async () => ({
      rewrite: (request: JsonObject) => ({ request }),
      close: () => {},
    }));
    const service = new SecondwindService({ createSession });
    const body = Buffer.from(JSON.stringify(toolRequest('unchanged')));

    expect(await service.rewrite({
      body,
      request: toolRequest('unchanged'),
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    })).toBe(body);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toMatchObject({
      mode: 'on',
      loaded: true,
      applied: { requests: 1 },
    });
  });

  it('applies on requests, bypasses off requests, and persists mode changes', async () => {
    const close = vi.fn();
    const rewrite = vi.fn((_request: JsonObject) => ({
      request: toolRequest('short'),
      stats: {
        blocks_rewritten: 1,
        input_tokens: 4_000,
        output_tokens: 1_000,
        tokens_saved: 3_000,
      },
    }));
    const persistMode = vi.fn();
    let clock = 0;
    const service = new SecondwindService({
      initialMode: 'on',
      persistMode,
      createSession: async () => ({ rewrite, close }),
      now: () => {
        clock += 5;
        return clock;
      },
    });
    const original = toolRequest('long tool output '.repeat(1_000));
    const body = Buffer.from(JSON.stringify(original));

    const applied = await service.rewrite({
      body,
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    });
    expect(applied).not.toBe(body);
    expect(JSON.parse(applied.toString())).toEqual(toolRequest('short'));
    expect(service.snapshot().applied).toMatchObject({
      requests: 1,
      pricedRequests: 1,
      unpricedRequests: 0,
      blocksRewritten: 1,
      tokensReduced: 3_000,
      estimatedTokenRequests: 0,
    });
    expect(service.snapshot().applied.estimatedSavingsUsd).toBeGreaterThan(0);
    expect(service.snapshot()).toMatchObject({
      mode: 'on',
      loaded: true,
      sessions: 0,
      applied: { requests: 1, blocksRewritten: 1 },
      latency: { samples: 1, medianMs: 5, p95Ms: 5 },
    });
    expect(rewrite).toHaveBeenCalledTimes(1);

    service.setMode('off');
    expect(await service.rewrite({
      body,
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    })).toBe(body);
    expect(rewrite).toHaveBeenCalledTimes(1);

    service.setMode('on');
    expect(persistMode).toHaveBeenLastCalledWith('on');
    const resumed = await service.rewrite({
      body,
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    });
    expect(resumed.equals(applied)).toBe(true);
    expect(rewrite).toHaveBeenCalledTimes(2);

    service.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('rewrites count requests without booking savings metrics', async () => {
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => ({
          request: toolRequest('short'),
          stats: { blocks_rewritten: 1 },
        }),
        close: () => {},
      }),
    });
    const original = toolRequest('long '.repeat(1_000));
    const rewritten = await service.rewrite({
      body: Buffer.from(JSON.stringify(original)),
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-luna',
      recordMetrics: false,
    });

    expect(JSON.parse(rewritten.toString())).toEqual(toolRequest('short'));
    expect(service.snapshot().applied.requests).toBe(0);
  });

  it('marks the compatibility estimate when optimizer token stats are absent', async () => {
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => ({
          request: toolRequest('short'),
          stats: { blocks_rewritten: 1 },
        }),
        close: () => {},
      }),
    });
    const original = toolRequest('long output '.repeat(1_000));

    await service.rewrite({
      body: Buffer.from(JSON.stringify(original)),
      request: original,
      sessionId: 'compatibility-fallback',
      modelId: 'gpt-5.6-sol',
    });

    expect(service.snapshot().applied).toMatchObject({
      requests: 1,
      tokensReduced: expect.any(Number),
      estimatedTokenRequests: 1,
    });
    expect(service.snapshot().applied.tokensReduced).toBeGreaterThan(0);
  });

  it('estimates recurring savings when a persistent session reuses frozen blocks', async () => {
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => ({
          request: toolRequest('short'),
          stats: {
            blocks_rewritten: 1,
            blocks_first_seen: 0,
            input_tokens: 0,
            output_tokens: 0,
            tokens_saved: 0,
          },
        }),
        close: () => {},
      }),
    });
    const original = toolRequest('long recurring output '.repeat(1_000));

    await service.rewrite({
      body: Buffer.from(JSON.stringify(original)),
      request: original,
      sessionId: 'persistent-session',
      modelId: 'gpt-5.6-sol',
    });

    expect(service.snapshot().applied).toMatchObject({
      requests: 1,
      blocksRewritten: 1,
      estimatedTokenRequests: 1,
    });
    expect(service.snapshot().applied.tokensReduced).toBeGreaterThan(0);
  });

  it('preserves exact request bytes when the optimizer makes no change', async () => {
    const request = toolRequest('already compact');
    const body = Buffer.from('{\n  "model": "sol", "messages": []\n}\n');
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => ({
          request,
          stats: { blocks_rewritten: 0 },
        }),
        close: () => {},
      }),
    });

    expect(await service.rewrite({
      body,
      request,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    })).toBe(body);
  });

  it('forwards optimized worker bytes without parsing or serializing them again', async () => {
    const request = toolRequest('large original output');
    const originalBody = Buffer.from(JSON.stringify(request));
    const optimizedBody = new TextEncoder().encode('worker-owned-wire-bytes');
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: (_request, body) => {
          expect(body).toBe(originalBody);
          return {
            body: optimizedBody,
            stats: {
              blocks_rewritten: 1,
              input_tokens: 100,
              output_tokens: 40,
              tokens_saved: 60,
            },
          };
        },
        close: () => {},
      }),
    });

    const rewritten = await service.rewrite({
      body: originalBody,
      request,
      modelId: 'gpt-5.6-sol',
    });

    expect(rewritten.toString()).toBe('worker-owned-wire-bytes');
    expect(service.snapshot().applied).toMatchObject({
      blocksRewritten: 1,
      inputTokensConsidered: 100,
      tokensReduced: 60,
      estimatedTokenRequests: 0,
    });
  });

  it('fails open and reports optimizer errors', async () => {
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => {
        throw new Error('native load failed');
      },
    });
    const request = toolRequest('original');
    const body = Buffer.from(JSON.stringify(request));

    expect(await service.rewrite({
      body,
      request,
      modelId: 'gpt-5.6-sol',
    })).toBe(body);
    expect(service.snapshot()).toMatchObject({
      errors: 1,
      lastError: 'native load failed',
      applied: { requests: 0 },
    });
  });

  it('reports unsupported models as unpriced instead of zero-dollar savings', async () => {
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => ({
          request: toolRequest('short'),
          stats: { blocks_rewritten: 1 },
        }),
        close: () => {},
      }),
    });
    const request = toolRequest('long output '.repeat(1_000));
    await service.rewrite({
      body: Buffer.from(JSON.stringify(request)),
      request,
      sessionId: 'optimizer-session',
      modelId: 'gpt-5.4',
    });

    expect(service.snapshot().applied).toMatchObject({
      requests: 1,
      pricedRequests: 0,
      unpricedRequests: 1,
      estimatedSavingsUsd: 0,
    });
  });

  it('prices savings from observed cache reads and cache writes', async () => {
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => ({
          request: toolRequest('short'),
          stats: {
            blocks_rewritten: 1,
            input_tokens: 2_000,
            output_tokens: 1_000,
            tokens_saved: 1_000,
          },
        }),
        close: () => {},
      }),
    });
    const request = toolRequest('long output');
    await service.rewrite({
      requestId: 'cache-aware',
      body: Buffer.from(JSON.stringify(request)),
      request,
      sessionId: 'optimizer:agent',
      reportingSessionId: 'parent-session',
      modelId: 'gpt-5.6-sol',
    });
    expect(service.snapshot().applied.estimatedSavingsUsd).toBe(0);

    service.handleTrace({
      kind: 'lifecycle',
      entry: {
        event: 'response_usage',
        requestId: 'cache-aware',
        modelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
        inputTokens: 100,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 100,
        outputTokens: 20,
      },
    });
    service.handleTrace({
      kind: 'lifecycle',
      entry: {
        event: 'response_completed',
        requestId: 'cache-aware',
        modelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
      },
    });

    expect(service.snapshot().applied.estimatedSavingsUsd).toBeCloseTo(0.001525);
    expect(service.snapshot().applied).toMatchObject({
      observedInputTokens: 1_000,
      savedInputTokens: 100,
      savedCachedInputTokens: 800,
      savedCacheWriteTokens: 100,
      estimatedInputSavingsUsd: expect.closeTo(0.0005),
      estimatedCacheSavingsUsd: expect.closeTo(0.001025),
      estimatedOutputSavingsUsd: 0,
    });
    expect(service.snapshot().lifetime.estimatedSavingsUsd).toBeCloseTo(0.001525);
    expect(service.snapshot().topSessions).toEqual([
      expect.objectContaining({
        sessionHash: hashSessionId('parent-session'),
        tokensReduced: 1_000,
        estimatedSavingsUsd: expect.closeTo(0.001525),
      }),
    ]);
  });

  it('groups agents under parent sessions and returns only the top three', async () => {
    const saved = [100, 400, 300, 200, 50];
    let index = 0;
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => {
          const tokensSaved = saved[index++]!;
          return {
            request: toolRequest('short'),
            stats: {
              blocks_rewritten: 1,
              input_tokens: 1_000 + tokensSaved,
              output_tokens: 1_000,
              tokens_saved: tokensSaved,
            },
          };
        },
        close: () => {},
      }),
    });
    const parentIds = ['parent-a', 'parent-a', 'parent-b', 'parent-c', 'parent-d'];
    for (const [requestIndex, reportingSessionId] of parentIds.entries()) {
      const request = toolRequest(`request-${requestIndex}`);
      await service.rewrite({
        body: Buffer.from(JSON.stringify(request)),
        request,
        sessionId: `${reportingSessionId}:agent-${requestIndex}`,
        reportingSessionId,
        modelId: 'gpt-5.6-sol',
      });
    }

    expect(service.snapshot().topSessions.map(session => ({
      sessionHash: session.sessionHash,
      tokensReduced: session.tokensReduced,
    }))).toEqual([
      { sessionHash: hashSessionId('parent-a'), tokensReduced: 500 },
      { sessionHash: hashSessionId('parent-b'), tokensReduced: 300 },
      { sessionHash: hashSessionId('parent-c'), tokensReduced: 200 },
    ]);
    expect(service.snapshot().lifetime).toMatchObject({
      requests: 5,
      blocksRewritten: 5,
      tokensReduced: 1_050,
    });
  });

  it('keeps fast-mode savings within one uniform context tier', async () => {
    const service = new SecondwindService({
      initialMode: 'on',
      createSession: async () => ({
        rewrite: () => ({
          request: toolRequest('short'),
          stats: {
            blocks_rewritten: 1,
            input_tokens: 275_000,
            output_tokens: 265_000,
            tokens_saved: 10_000,
          },
        }),
        close: () => {},
      }),
    });
    const request = toolRequest('long output');
    await service.rewrite({
      requestId: 'long-context',
      body: Buffer.from(JSON.stringify(request)),
      request,
      sessionId: 'long-context',
      modelId: 'gpt-5.6-sol',
      processingMode: 'fast',
    });
    service.handleTrace({
      kind: 'lifecycle',
      entry: {
        event: 'response_usage',
        requestId: 'long-context',
        modelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
        inputTokens: 265_000,
        outputTokens: 10_000,
      },
    });
    service.handleTrace({
      kind: 'lifecycle',
      entry: {
        event: 'response_completed',
        requestId: 'long-context',
        modelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
      },
    });

    const original = estimateApiCost({
      modelId: 'gpt-5.6-sol',
      processingMode: 'fast',
      inputTokens: 275_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    })!;
    const optimized = estimateApiCost({
      modelId: 'gpt-5.6-sol',
      processingMode: 'fast',
      inputTokens: 265_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    })!;
    expect(original.total).toBeGreaterThan(optimized.total);
    expect(service.snapshot().applied.estimatedSavingsUsd)
      .toBeCloseTo(original.total - optimized.total);
  });

  it('uses request-local optimizer sessions while tracking active conversations', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const createSession = vi.fn(async () => {
      await gate;
      return {
        rewrite: (request: JsonObject) => ({
          request,
          stats: { blocks_rewritten: 0 },
        }),
        close: () => {},
      };
    });
    const service = new SecondwindService({
      initialMode: 'on',
      createSession,
    });
    const request = toolRequest('concurrent');
    const body = Buffer.from(JSON.stringify(request));
    const first = service.rewrite({
      body,
      request,
      sessionId: 'shared',
      modelId: 'gpt-5.6-sol',
    });
    const second = service.rewrite({
      body,
      request,
      sessionId: 'shared',
      modelId: 'gpt-5.6-sol',
    });
    expect(service.snapshot().sessions).toBe(1);
    release();
    await Promise.all([first, second]);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(service.snapshot().sessions).toBe(0);
  });

  it('keeps missing-session requests ephemeral and isolates conversation keys', async () => {
    const close = vi.fn();
    const createSession = vi.fn(async () => ({
      rewrite: (request: JsonObject) => ({
        request,
        stats: { blocks_rewritten: 0 },
      }),
      close,
    }));
    const service = new SecondwindService({
      initialMode: 'on',
      createSession,
    });
    const request = toolRequest('isolated');
    const body = Buffer.from(JSON.stringify(request));

    await service.rewrite({ body, request, modelId: 'gpt-5.6-sol' });
    await service.rewrite({ body, request, modelId: 'gpt-5.6-sol' });
    await service.rewrite({
      body,
      request,
      sessionId: 'parent:agent-a',
      modelId: 'gpt-5.6-sol',
    });
    await service.rewrite({
      body,
      request,
      sessionId: 'parent:agent-b',
      modelId: 'gpt-5.6-sol',
    });

    expect(createSession).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(4);
    expect(service.snapshot().sessions).toBe(0);
  });

  it('loads the real native package and compresses structured Anthropic tool output', async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, 'tests/fixtures/secondwind-native-smoke.ts'],
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    // SAFETY: The test fixture defines the asserted runtime shape.
    const result = JSON.parse(stdout) as {
      originalBytes: number;
      rewrittenBytes: number;
      repeatedBytes: number;
      repeatStable: boolean;
      snapshot: ReturnType<SecondwindService['snapshot']>;
    };
    expect(result.rewrittenBytes).toBeLessThan(result.originalBytes);
    expect(result.repeatedBytes).toBe(result.rewrittenBytes);
    expect(result.repeatStable).toBe(true);
    expect(result.snapshot.applied).toMatchObject({
      requests: 2,
      blocksRewritten: 2,
      estimatedTokenRequests: 0,
    });
    expect(result.snapshot.applied.tokensReduced).toBeGreaterThan(0);
  });
});
