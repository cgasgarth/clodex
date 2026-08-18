// tests/outbound-proxy.test.ts
import { describe, it, expect } from 'bun:test';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import {
  hasOutboundProxyEnv,
  installOutboundProxyDispatcher,
  noProxyBypasses,
  outboundProxyUrlForTarget,
} from '../src/transport/outbound-proxy.js';

const PROXY = 'http://127.0.0.1:8888';

const restoreEnvironmentVariable = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

describe('hasOutboundProxyEnv', () => {
  it('is false with no proxy vars or blank values', () => {
    expect(hasOutboundProxyEnv({})).toBe(false);
    expect(hasOutboundProxyEnv({ HTTPS_PROXY: '  ' })).toBe(false);
    expect(hasOutboundProxyEnv({ NO_PROXY: '*' })).toBe(false);
  });

  it('is true for any of the four proxy var spellings', () => {
    expect(hasOutboundProxyEnv({ HTTPS_PROXY: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ https_proxy: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ HTTP_PROXY: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ http_proxy: PROXY })).toBe(true);
  });
});

describe('outboundProxyUrlForTarget', () => {
  it('uses HTTPS_PROXY for https and wss targets', () => {
    const env = { HTTPS_PROXY: PROXY };
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1/responses', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('wss://chatgpt.com/backend-api/responses', env)).toBe(PROXY);
    // http targets do not fall back to HTTPS_PROXY
    expect(outboundProxyUrlForTarget('http://models.dev/api.json', env)).toBeUndefined();
  });

  it('uses HTTP_PROXY for http and ws targets only', () => {
    const env = { HTTP_PROXY: PROXY };
    expect(outboundProxyUrlForTarget('http://models.dev/api.json', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('ws://localhost:9999/x', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1', env)).toBeUndefined();
  });

  it('prefers the uppercase spelling and trims values', () => {
    expect(outboundProxyUrlForTarget('https://x.test/', {
      HTTPS_PROXY: ` ${PROXY} `,
      https_proxy: 'http://other:1',
    })).toBe(PROXY);
  });

  it('returns undefined for unparseable target URLs', () => {
    expect(outboundProxyUrlForTarget('not a url', { HTTPS_PROXY: PROXY })).toBeUndefined();
  });

  it('honors NO_PROXY', () => {
    const env = { HTTPS_PROXY: PROXY, NO_PROXY: 'api.openai.com' };
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1', env)).toBeUndefined();
    expect(outboundProxyUrlForTarget('https://chatgpt.com/x', env)).toBe(PROXY);
  });
});

describe('noProxyBypasses', () => {
  it('matches exact hosts, subdomains, and dot/star suffixes', () => {
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: 'api.openai.com' })).toBe(true);
    // bare domain also matches subdomains (curl semantics)
    expect(noProxyBypasses('sub.openai.com', { NO_PROXY: 'openai.com' })).toBe(true);
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: '.openai.com' })).toBe(true);
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: '*.openai.com' })).toBe(true);
    expect(noProxyBypasses('openai.com.evil.test', { NO_PROXY: 'openai.com' })).toBe(false);
    expect(noProxyBypasses('notopenai.com', { NO_PROXY: 'openai.com' })).toBe(false);
  });

  it('supports the * wildcard, lists, ports, and lowercase spelling', () => {
    expect(noProxyBypasses('anything.test', { NO_PROXY: '*' })).toBe(true);
    expect(noProxyBypasses('b.test', { NO_PROXY: 'a.test, b.test' })).toBe(true);
    expect(noProxyBypasses('c.test', { NO_PROXY: 'c.test:443' })).toBe(true);
    expect(noProxyBypasses('d.test', { no_proxy: 'd.test' })).toBe(true);
    expect(noProxyBypasses('e.test', {})).toBe(false);
  });
});

describe('installOutboundProxyDispatcher', () => {
  it('routes Bun global fetch through the configured local proxy', async () => {
    let directRequestCount = 0;
    let proxyRequestCount = 0;
    const targetServer = Bun.serve({
      port: 0,
      fetch: () => {
        directRequestCount += 1;
        return new Response('direct');
      },
    });
    const proxyServer = Bun.serve({
      port: 0,
      fetch: () => {
        proxyRequestCount += 1;
        return new Response('proxied');
      },
    });
    const previousDispatcher = getGlobalDispatcher();
    const previousHttpProxy = process.env.HTTP_PROXY;
    const previousLowercaseHttpProxy = process.env.http_proxy;
    const previousHttpsProxy = process.env.HTTPS_PROXY;
    const previousLowercaseHttpsProxy = process.env.https_proxy;
    const previousNoProxy = process.env.NO_PROXY;
    const previousLowercaseNoProxy = process.env.no_proxy;

    try {
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxyServer.port}`;
      delete process.env.http_proxy;
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      expect(await installOutboundProxyDispatcher()).toBe(true);
      expect(getGlobalDispatcher()).not.toBe(previousDispatcher);

      const response = await fetch(`http://127.0.0.1:${targetServer.port}/probe`);
      expect(await response.text()).toBe('proxied');
      expect(response.status).toBe(200);
      expect(proxyRequestCount).toBe(1);
      expect(directRequestCount).toBe(0);
    } finally {
      setGlobalDispatcher(previousDispatcher);
      restoreEnvironmentVariable('HTTP_PROXY', previousHttpProxy);
      restoreEnvironmentVariable('http_proxy', previousLowercaseHttpProxy);
      restoreEnvironmentVariable('HTTPS_PROXY', previousHttpsProxy);
      restoreEnvironmentVariable('https_proxy', previousLowercaseHttpsProxy);
      restoreEnvironmentVariable('NO_PROXY', previousNoProxy);
      restoreEnvironmentVariable('no_proxy', previousLowercaseNoProxy);
      await Promise.all([targetServer.stop(true), proxyServer.stop(true)]);
    }
  });
});
