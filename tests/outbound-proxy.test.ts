// tests/outbound-proxy.test.ts
import { afterAll, describe, expect, it } from 'bun:test';
import { outboundProxyUrlForTarget } from '../src/transport/outbound-proxy.js';

const PROXY_NAMES = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
] as const;

describe('outboundProxyUrlForTarget', () => {
  it('selects the proxy by scheme and falls back to ALL_PROXY', () => {
    const proxy = 'http://127.0.0.1:8888';
    expect(outboundProxyUrlForTarget('wss://chatgpt.com/backend-api/responses', { HTTPS_PROXY: proxy })).toBe(proxy);
    expect(outboundProxyUrlForTarget('ws://localhost:9999/x', { HTTP_PROXY: proxy })).toBe(proxy);
    expect(outboundProxyUrlForTarget('wss://chatgpt.com/x', { HTTP_PROXY: proxy })).toBeUndefined();
    expect(outboundProxyUrlForTarget('wss://chatgpt.com/x', { ALL_PROXY: proxy })).toBe(proxy);
    expect(outboundProxyUrlForTarget('not a url', { HTTPS_PROXY: proxy })).toBeUndefined();
  });

  // Bun's fetch() applies the proxy environment by itself. The WebSocket
  // transport must make the same choice for the same environment.
  describe('matches Bun fetch()', () => {
    let proxyHits = 0;
    const proxyListener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          proxyHits += 1;
          socket.end();
        },
      },
    });
    const proxy = `http://127.0.0.1:${proxyListener.port}`;
    const refused = 'http://127.0.0.1:1';
    const saved = PROXY_NAMES.map(name => [name, process.env[name]] as const);
    afterAll(() => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      proxyListener.stop(true);
    });

    const cases: Array<[string, string, Partial<Record<typeof PROXY_NAMES[number], string>>]> = [
      ['https uses HTTPS_PROXY', 'https://x.invalid/', { HTTPS_PROXY: proxy }],
      ['https ignores HTTP_PROXY', 'https://x.invalid/', { HTTP_PROXY: proxy }],
      ['http ignores HTTPS_PROXY', 'http://x.invalid/', { HTTPS_PROXY: proxy }],
      ['ALL_PROXY fallback', 'https://x.invalid/', { ALL_PROXY: proxy }],
      ['lowercase all_proxy', 'https://x.invalid/', { all_proxy: proxy }],
      ['lowercase name wins', 'https://x.invalid/', { HTTPS_PROXY: proxy, https_proxy: refused }],
      ['blank lowercase falls through', 'https://x.invalid/', { https_proxy: '', HTTPS_PROXY: proxy }],
      ['scheme proxy wins over ALL_PROXY', 'https://x.invalid/', { https_proxy: refused, ALL_PROXY: proxy }],
      ['exact host', 'https://example.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'example.invalid' }],
      ['bare domain covers subdomains', 'https://a.example.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'example.invalid' }],
      ['leading dot covers apex', 'https://example.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: '.example.invalid' }],
      ['wildcard covers subdomains', 'https://a.example.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: '*.example.invalid' }],
      ['wildcard is not a substring match', 'https://ax.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: '*x.invalid' }],
      ['middle wildcard is literal', 'https://a.b.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'a.*.invalid' }],
      ['suffix boundary', 'https://notexample.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'example.invalid' }],
      ['case and spaces', 'https://x.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: ' a.invalid , X.Invalid ' }],
      ['trailing dots', 'https://x.invalid./', { HTTPS_PROXY: proxy, NO_PROXY: 'x.invalid.' }],
      ['scheme in entry is literal', 'https://x.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'https://x.invalid' }],
      ['host:port with default port', 'https://x.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'x.invalid:443' }],
      ['host:port mismatch', 'https://x.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'x.invalid:8443' }],
      ['IPv4 address', 'https://127.0.0.1:1/', { HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1' }],
      ['IPv4 address and port mismatch', 'https://127.0.0.1:1/', { HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1:2' }],
      ['IPv4 CIDR', 'https://127.0.0.1:1/', { HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.0/8' }],
      ['IPv4 CIDR mismatch', 'https://127.0.0.1:1/', { HTTPS_PROXY: proxy, NO_PROXY: '10.0.0.0/8' }],
      ['bare IPv6 address', 'https://[::1]:1/', { HTTPS_PROXY: proxy, NO_PROXY: '0:0:0:0:0:0:0:1' }],
      ['IPv6 CIDR', 'https://[::1]:1/', { HTTPS_PROXY: proxy, NO_PROXY: '::/8' }],
      ['bracketed IPv6 and port', 'https://[::1]:1/', { HTTPS_PROXY: proxy, NO_PROXY: '[::1]:1' }],
      ['no implicit localhost', 'https://localhost:1/', { HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1' }],
      ['star in list', 'https://x.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'a.invalid,*' }],
      ['lowercase no_proxy wins', 'https://y.invalid/', { HTTPS_PROXY: proxy, NO_PROXY: 'y.invalid', no_proxy: 'x.invalid' }],
      ['blank no_proxy falls through', 'https://x.invalid/', { HTTPS_PROXY: proxy, no_proxy: '', NO_PROXY: 'x.invalid' }],
    ];

    for (const [label, url, env] of cases) {
      it(label, async () => {
        for (const name of PROXY_NAMES) delete process.env[name];
        Object.assign(process.env, env);
        const before = proxyHits;
        await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
        const bunUsedProxy = proxyHits > before;
        const selected = outboundProxyUrlForTarget(url.replace(/^http/, 'ws'), env);
        expect(selected === proxy).toBe(bunUsedProxy);
      });
    }
  });
});
