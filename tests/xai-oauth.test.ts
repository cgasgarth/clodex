import { describe, expect, it, vi } from 'bun:test';
import { runXaiDeviceCodeFlow } from '../src/oauth/xai.js';
import { createXaiSubscriptionFetch } from '../src/oauth/xai-proxy.js';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function sseEvent(payload: Record<string, unknown>, eventName?: string): string {
  return `${eventName ? `event: ${eventName}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
}

function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: SSE_HEADERS });
}

describe('xAI SuperGrok OAuth', () => {
  it('requests a device code and polls the pinned token endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/device',
        expires_in: 900,
        interval: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const onDeviceCode = vi.fn();
      const result = await runXaiDeviceCodeFlow(onDeviceCode, {
        sleep: async () => {},
        now: () => 1_000,
      });

      expect(onDeviceCode).toHaveBeenCalledWith({
        url: 'https://auth.x.ai/device',
        userCode: 'ABCD-EFGH',
      });
      expect(result.tokens).toMatchObject({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });
      expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
        'https://auth.x.ai/oauth2/device/code',
        'https://auth.x.ai/oauth2/token',
      ]);
      expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('grok-cli%3Aaccess');
      expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('device_code=device-secret');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds the required CLI proxy headers without exposing other models', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const proxyFetch = createXaiSubscriptionFetch('grok-4.6', 'claude-session', transport as typeof fetch);

    await proxyFetch('https://cli-chat-proxy.grok.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer subscription-token' },
    });

    const [, init] = transport.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer subscription-token');
    expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(headers.get('x-grok-model-override')).toBe('grok-4.6');
    expect(headers.get('x-grok-session-id')).toBe('claude-session');
    expect(headers.get('x-grok-conv-id')).toBe('claude-session');
    expect(headers.get('x-grok-req-id')).toBeTruthy();
    expect(headers.get('x-grok-doom-loop-check')).toBe('1024');
    expect(init.redirect).toBe('error');

    expect(() => createXaiSubscriptionFetch('grok-4.5')).toThrow('only grok-4.6');
    await expect(proxyFetch('https://api.x.ai/v1/responses')).rejects.toThrow(
      'unexpected endpoint',
    );
  });

  it('discards a confident thinking loop and resamples the unchanged request', async () => {
    const poisoned = [
      sseEvent({ type: 'response.created', response: { id: 'poisoned' } }),
      sseEvent({
        type: 'response.reasoning_text.delta', item_id: 'r1', content_index: 0,
        output_index: 0, delta: 'poisoned thought',
      }),
      sseEvent({
        type: 'response.doom_loop_check',
        doom_loop_check: { triggers: ['tail_repetition:8@thinking'] },
      }, 'response.doom_loop_check'),
    ].join('');
    const clean = [
      sseEvent({ type: 'response.created', response: { id: 'clean' } }),
      sseEvent({
        type: 'response.reasoning_text.delta', item_id: 'r2', content_index: 0,
        output_index: 0, delta: 'fresh thought',
      }),
      sseEvent({
        type: 'response.output_text.delta', item_id: 'm2', content_index: 0,
        output_index: 1, delta: 'clean answer',
      }),
    ].join('');
    const transport = vi.fn()
      .mockResolvedValueOnce(streamedResponse([poisoned.slice(0, 57), poisoned.slice(57)]))
      .mockResolvedValueOnce(streamedResponse([clean]));
    const waits: number[] = [];
    const proxyFetch = createXaiSubscriptionFetch(
      'grok-4.6',
      'session-retry',
      transport as typeof fetch,
      { random: () => 0, sleep: async milliseconds => { waits.push(milliseconds); } },
    );

    const response = await proxyFetch('https://cli-chat-proxy.grok.com/v1/responses', {
      method: 'POST',
      body: '{"input":"same prefix"}',
    });
    const body = await response.text();

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(call => call[1]?.body))
      .toEqual(['{"input":"same prefix"}', '{"input":"same prefix"}']);
    const requestIds = transport.mock.calls.map(call => new Headers(call[1]?.headers).get('x-grok-req-id'));
    expect(new Set(requestIds).size).toBe(2);
    expect(waits).toEqual([0]);
    expect(body).not.toContain('poisoned');
    expect(body).not.toContain('response.doom_loop_check');
    expect(body).toContain('fresh thought');
    expect(body).toContain('clean answer');
  });

  it('accepts response-channel and low-logprob signals without resampling', async () => {
    const stream = [
      sseEvent({ type: 'response.created', response: { id: 'ordinary' } }),
      sseEvent({
        type: 'response.doom_loop_check',
        doom_loop_check: {
          triggers: ['tail_repetition:4@response', 'low_logprob@thinking'],
        },
      }),
      sseEvent({
        type: 'response.output_text.delta', item_id: 'm1', content_index: 0,
        output_index: 0, delta: 'visible answer',
      }),
    ].join('');
    const transport = vi.fn(async () => streamedResponse([stream]));
    const proxyFetch = createXaiSubscriptionFetch('grok-4.6', 'session-observe', transport as typeof fetch);

    const body = await (await proxyFetch('https://cli-chat-proxy.grok.com/v1/responses')).text();

    expect(transport).toHaveBeenCalledOnce();
    expect(body).not.toContain('response.doom_loop_check');
    expect(body).toContain('visible answer');
  });

  it('accepts the third looping sample after the native two-resample budget', async () => {
    const attempt = (number: number) => [
      sseEvent({ type: 'response.created', response: { id: `attempt-${number}` } }),
      sseEvent({
        type: 'response.reasoning_text.delta', item_id: `r${number}`, content_index: 0,
        output_index: 0, delta: `thought-${number}`,
      }),
      sseEvent({
        type: 'response.doom_loop_check',
        doom_loop_check: { triggers: ['tail_repetition:32@thinking'] },
      }),
      sseEvent({
        type: 'response.output_text.delta', item_id: `m${number}`, content_index: 0,
        output_index: 1, delta: `answer-${number}`,
      }),
    ].join('');
    const transport = vi.fn()
      .mockResolvedValueOnce(streamedResponse([attempt(1)]))
      .mockResolvedValueOnce(streamedResponse([attempt(2)]))
      .mockResolvedValueOnce(streamedResponse([attempt(3)]));
    const waits: number[] = [];
    const proxyFetch = createXaiSubscriptionFetch(
      'grok-4.6',
      'session-budget',
      transport as typeof fetch,
      { random: () => 1, sleep: async milliseconds => { waits.push(milliseconds); } },
    );

    const body = await (await proxyFetch('https://cli-chat-proxy.grok.com/v1/responses')).text();

    expect(transport).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([250, 250]);
    expect(body).not.toContain('attempt-1');
    expect(body).not.toContain('attempt-2');
    expect(body).toContain('thought-3');
    expect(body).toContain('answer-3');
    expect(body).not.toContain('response.doom_loop_check');
  });

  it('uses a terminal thinking-loop signal when no provider output committed', async () => {
    const terminalLoop = [
      sseEvent({
        type: 'response.reasoning_text.delta', item_id: 'r1', content_index: 0,
        output_index: 0, delta: 'terminal poison',
      }),
      sseEvent({
        type: 'response.completed',
        response: {
          id: 'poisoned',
          doom_loop_check: { triggers: ['tail_repetition:2@thinking'] },
        },
      }),
    ].join('');
    const clean = sseEvent({
      type: 'response.output_text.delta', item_id: 'm2', content_index: 0,
      output_index: 0, delta: 'terminal recovery worked',
    });
    const transport = vi.fn()
      .mockResolvedValueOnce(streamedResponse([terminalLoop]))
      .mockResolvedValueOnce(streamedResponse([clean]));
    const proxyFetch = createXaiSubscriptionFetch(
      'grok-4.6',
      'session-terminal',
      transport as typeof fetch,
      { random: () => 0, sleep: async () => {} },
    );

    const body = await (await proxyFetch('https://cli-chat-proxy.grok.com/v1/responses')).text();

    expect(transport).toHaveBeenCalledTimes(2);
    expect(body).not.toContain('terminal poison');
    expect(body).toContain('terminal recovery worked');
  });

  it('swallows malformed detector frames and never replays committed output', async () => {
    const stream = [
      sseEvent({
        type: 'response.output_text.delta', item_id: 'm1', content_index: 0,
        output_index: 0, delta: 'already committed',
      }),
      'event: response.doom_loop_check\ndata: definitely-not-json\n\n',
      sseEvent({
        type: 'response.doom_loop_check',
        doom_loop_check: { triggers: ['tail_repetition:2@thinking'] },
      }),
      sseEvent({
        type: 'response.output_text.delta', item_id: 'm1', content_index: 0,
        output_index: 0, delta: ' and complete',
      }),
    ].join('');
    const transport = vi.fn(async () => streamedResponse([stream]));
    const proxyFetch = createXaiSubscriptionFetch('grok-4.6', 'session-committed', transport as typeof fetch);

    const body = await (await proxyFetch('https://cli-chat-proxy.grok.com/v1/responses')).text();

    expect(transport).toHaveBeenCalledOnce();
    expect(body).toContain('already committed');
    expect(body).toContain('and complete');
    expect(body).not.toContain('doom_loop_check');
    expect(body).not.toContain('definitely-not-json');
  });
});
