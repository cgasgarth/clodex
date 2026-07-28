import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProxyLaunchTicket } from '../src/http-proxy/server.js';
import { computeWrapperEnv } from '../src/wrapper-env.js';
import { startProxyCatalog } from '../src/proxy.js';

const roots: string[] = [];
afterEach(() => {
  delete process.env['CLODEX_HOME'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed-account launch ticket transport', () => {
  it('embeds an opaque ticket in the proxy URL without exposing an account id', () => {
    const env = computeWrapperEnv({}, {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/tmp/ca.pem',
      startedAt: new Date().toISOString(),
    }, 'opaque_ticket-1');
    const proxy = new URL(env['HTTPS_PROXY']!);
    expect(proxy.username).toBe('clodex');
    expect(proxy.password).toBe('opaque_ticket-1');
    expect(env['CLODEX_LAUNCH_TICKET']).toBe('opaque_ticket-1');
  });

  it('accepts only clodex Basic proxy credentials', () => {
    const header = `Basic ${Buffer.from('clodex:opaque_ticket-1').toString('base64')}`;
    expect(parseProxyLaunchTicket(header)).toBe('opaque_ticket-1');
    expect(parseProxyLaunchTicket(`Basic ${Buffer.from('other:value').toString('base64')}`))
      .toBeUndefined();
    expect(parseProxyLaunchTicket('Bearer value')).toBeUndefined();
  });

  it('carries the launch ticket in a daemon endpoint API key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-endpoint-ticket-'));
    roots.push(root);
    process.env['CLODEX_HOME'] = root;
    let observedTicket: string | undefined;
    const handle = await startProxyCatalog([{
      aliasId: 'sol',
      realModelId: 'gpt-test',
      displayName: 'Sol',
      upstreamUrl: 'https://example.invalid/v1/responses',
      apiKey: '',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      providerId: 'openai-oauth',
      authType: 'oauth',
    }], 'sol', false, undefined, undefined, undefined, undefined, async (route, context) => {
      observedTicket = context.launchTicket;
      return route;
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': `${handle.token}.ticket.part-two`,
        },
        body: JSON.stringify({
          model: 'sol',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      expect(response.status).toBe(200);
      expect(observedTicket).toBe('ticket.part-two');
    } finally {
      handle.close();
    }
  });
});
