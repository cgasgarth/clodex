import { describe, expect, it, vi } from 'bun:test';
import { runXaiDeviceCodeFlow } from '../src/oauth/xai.js';
import { createXaiSubscriptionFetch } from '../src/oauth/xai-proxy.js';

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
    expect(init.redirect).toBe('error');

    expect(() => createXaiSubscriptionFetch('grok-4.5')).toThrow('only grok-4.6');
    await expect(proxyFetch('https://api.x.ai/v1/responses')).rejects.toThrow(
      'unexpected endpoint',
    );
  });
});
