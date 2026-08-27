import { describe, it, expect, afterEach } from 'bun:test';
import http from 'node:http';
import { startProxy, type ProxyHandle } from '../src/proxy/index.js';

describe('proxy GET /v1/models with 1M context ids', () => {
  let handle: ProxyHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  it('returns the configured 1M context window', async () => {
    handle = await startProxy('', 'custom-large', false, 1_000_000, {
      npm: '@ai-sdk/openai-compatible',
      upstreamModelId: 'custom-large',
    });

    async function get(path: string) {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: handle!.port, path }, res => {
          let d = '';
          res.on('data', c => { d += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
        }).on('error', reject);
      });
    }

    const list = await get('/v1/models');
    expect(list.status).toBe(200);
    // SAFETY: The test fixture defines the asserted runtime shape.
    const listJson = JSON.parse(list.body) as { data: Array<{ id: string; context_window: number }> };
    expect(listJson.data[0]?.id).toBe('custom-large[1m]');
    expect(listJson.data[0]?.context_window).toBe(1_000_000);

    const withSuffix = await get('/v1/models/custom-large%5B1m%5D');
    expect(withSuffix.status).toBe(200);
    expect(JSON.parse(withSuffix.body).context_window).toBe(1_000_000);

    const bare = await get('/v1/models/custom-large');
    expect(bare.status).toBe(200);
    expect(JSON.parse(bare.body).context_window).toBe(1_000_000);
  });
});
