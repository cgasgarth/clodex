import { describe, expect, it, vi } from 'bun:test';
import { SecondwindService } from '../src/daemon/secondwind.js';

function toolRequest(content: string): Record<string, unknown> {
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
  it('defaults to off and does not load the optimizer', async () => {
    const createSession = vi.fn();
    const service = new SecondwindService({ createSession });
    const body = Buffer.from(JSON.stringify(toolRequest('unchanged')));

    expect(await service.rewrite({
      body,
      request: toolRequest('unchanged'),
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    })).toBe(body);
    expect(createSession).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({
      mode: 'off',
      loaded: false,
      applied: { requests: 0 },
      shadow: { requests: 0 },
    });
  });

  it('measures shadow requests, applies on requests, and persists mode changes', async () => {
    const close = vi.fn();
    const rewrite = vi.fn((request: Record<string, unknown>) => ({
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
      initialMode: 'shadow',
      persistMode,
      createSession: async () => ({ rewrite, close }),
      now: () => {
        clock += 5;
        return clock;
      },
    });
    const original = toolRequest('long tool output '.repeat(1_000));
    const body = Buffer.from(JSON.stringify(original));

    expect(await service.rewrite({
      body,
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    })).toBe(body);
    expect(service.snapshot().shadow).toMatchObject({
      requests: 1,
      pricedRequests: 1,
      unpricedRequests: 0,
      blocksRewritten: 1,
      tokensReduced: 3_000,
      estimatedTokenRequests: 0,
    });
    expect(service.snapshot().shadow.estimatedSavingsUsd).toBeGreaterThan(0);

    service.setMode('on');
    expect(persistMode).toHaveBeenCalledWith('on');
    const applied = await service.rewrite({
      body,
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    });
    expect(applied).not.toBe(body);
    expect(JSON.parse(applied.toString())).toEqual(toolRequest('short'));
    expect(service.snapshot()).toMatchObject({
      mode: 'on',
      loaded: true,
      sessions: 1,
      applied: { requests: 1, blocksRewritten: 1 },
      latency: { samples: 2, medianMs: 5, p95Ms: 5 },
    });
    expect(rewrite).toHaveBeenCalledTimes(2);

    service.setMode('off');
    expect(await service.rewrite({
      body,
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    })).toBe(body);
    expect(rewrite).toHaveBeenCalledTimes(2);

    service.setMode('on');
    const resumed = await service.rewrite({
      body,
      request: original,
      sessionId: 'session-1',
      modelId: 'gpt-5.6-sol',
    });
    expect(resumed.equals(applied)).toBe(true);
    expect(rewrite).toHaveBeenCalledTimes(3);

    service.close();
    expect(close).toHaveBeenCalledOnce();
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
      initialMode: 'shadow',
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

    expect(service.snapshot().shadow).toMatchObject({
      requests: 1,
      tokensReduced: expect.any(Number),
      estimatedTokenRequests: 1,
    });
    expect(service.snapshot().shadow.tokensReduced).toBeGreaterThan(0);
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
      initialMode: 'shadow',
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
      sessionId: 'spark-session',
      modelId: 'gpt-5.3-codex-spark',
    });

    expect(service.snapshot().shadow).toMatchObject({
      requests: 1,
      pricedRequests: 0,
      unpricedRequests: 1,
      estimatedSavingsUsd: 0,
    });
  });

  it('shares one optimizer session across concurrent requests for a conversation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const createSession = vi.fn(async () => {
      await gate;
      return {
        rewrite: (request: Record<string, unknown>) => ({
          request,
          stats: { blocks_rewritten: 0 },
        }),
        close: () => {},
      };
    });
    const service = new SecondwindService({
      initialMode: 'shadow',
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
    release();
    await Promise.all([first, second]);

    expect(createSession).toHaveBeenCalledOnce();
    expect(service.snapshot().sessions).toBe(1);
  });

  it('keeps missing-session requests ephemeral and isolates conversation keys', async () => {
    const close = vi.fn();
    const createSession = vi.fn(async () => ({
      rewrite: (request: Record<string, unknown>) => ({
        request,
        stats: { blocks_rewritten: 0 },
      }),
      close,
    }));
    const service = new SecondwindService({
      initialMode: 'shadow',
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
    expect(close).toHaveBeenCalledTimes(2);
    expect(service.snapshot().sessions).toBe(2);
  });

  it('loads the real native package and compresses structured Anthropic tool output', async () => {
    const records = Array.from({ length: 400 }, (_, index) => ({
      id: index,
      path: `file-${index}.txt`,
      state: index % 2 ? 'open' : 'closed',
      owner: `team-${index % 5}`,
    }));
    const request = toolRequest(JSON.stringify(records));
    const body = Buffer.from(JSON.stringify(request));
    const service = new SecondwindService({ initialMode: 'on' });

    const rewritten = await service.rewrite({
      body,
      request,
      sessionId: 'native-smoke',
      modelId: 'gpt-5.6-sol',
    });

    expect(rewritten.length).toBeLessThan(body.length);
    expect(service.snapshot().applied).toMatchObject({
      requests: 1,
      blocksRewritten: 1,
      estimatedTokenRequests: 0,
    });
    expect(service.snapshot().applied.tokensReduced).toBeGreaterThan(0);
    service.close();
  });
});
