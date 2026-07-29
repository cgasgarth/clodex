import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeWrapperEnv,
  LAUNCH_TICKET_HEADER,
  LOCAL_GATEWAY_API_KEY,
  setAnthropicCustomHeader,
  wrapperRequiresServer,
} from '../src/wrapper-env.js';
import {
  readLiveServerRuntimeState,
  registerServerRuntimeState,
  type ServerRuntimeState,
} from '../src/server-runtime.js';

const baseEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  ANTHROPIC_BASE_URL: 'https://corp.example/anthropic',
  HTTPS_PROXY: 'http://corp-proxy:8080',
  https_proxy: 'http://corp-proxy:8080',
  HOME: '/Users/someone',
};

describe('computeWrapperEnv', () => {
  it('proxy-mode server: injects proxy vars + CA and removes ANTHROPIC_BASE_URL', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv(baseEnv, state);

    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(env[name]).toBe('http://127.0.0.1:17645');
    }
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/home/u/.clodex/http-proxy/clodex-ca.pem');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('proxy-mode server removes Anthropic bypasses while preserving unrelated hosts', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const env = computeWrapperEnv({
      ...baseEnv,
      NO_PROXY: 'localhost,api.anthropic.com,.anthropic.com,.internal.example,*',
    }, state);

    expect(env['NO_PROXY']).toBe('localhost,.internal.example');
    expect(env['no_proxy']).toBe('localhost,.internal.example');
  });

  it('merges uppercase and lowercase bypass lists before filtering', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.clodex/http-proxy/clodex-ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const env = computeWrapperEnv({
      ...baseEnv,
      NO_PROXY: 'localhost,api.anthropic.com',
      no_proxy: 'corp.internal,.anthropic.com',
    }, state);

    expect(env['NO_PROXY']).toBe('localhost,corp.internal');
    expect(env['no_proxy']).toBe('localhost,corp.internal');
  });

  it('endpoint-mode server: points ANTHROPIC_BASE_URL at the gateway and clears proxy vars', () => {
    const state: ServerRuntimeState = {
      mode: 'endpoint',
      port: 4242,
      pid: process.pid,
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv(baseEnv, state);

    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:4242/anthropic');
    expect(env['ANTHROPIC_API_KEY']).toBe(LOCAL_GATEWAY_API_KEY);
    expect(LOCAL_GATEWAY_API_KEY.length).toBeGreaterThan(0);
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(env[name]).toBeUndefined();
    }
  });

  it('endpoint-mode daemon preserves its token and carries the pinned account ticket', () => {
    const state: ServerRuntimeState = {
      mode: 'endpoint',
      port: 17647,
      pid: process.pid,
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv({
      ...baseEnv,
      ANTHROPIC_API_KEY: 'stable-local-token.old-ticket',
      ANTHROPIC_CUSTOM_HEADERS: [
        'x-existing: retained',
        `${LAUNCH_TICKET_HEADER}: stale-ticket`,
      ].join('\n'),
    }, state, 'new-ticket.part-two');

    expect(env['ANTHROPIC_API_KEY']).toBe('stable-local-token');
    expect(env['CLODEX_LAUNCH_TICKET']).toBe('new-ticket.part-two');
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe([
      'x-existing: retained',
      `${LAUNCH_TICKET_HEADER}: new-ticket.part-two`,
    ].join('\n'));
  });

  it('removes a stale launch-ticket header when endpoint mode has no ticket', () => {
    const state: ServerRuntimeState = {
      mode: 'endpoint',
      port: 4242,
      pid: process.pid,
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv({
      ...baseEnv,
      ANTHROPIC_CUSTOM_HEADERS: `${LAUNCH_TICKET_HEADER}: stale-ticket`,
    }, state);

    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBeUndefined();
  });

  it('rejects newline injection in custom header values', () => {
    const env = { ...baseEnv };
    expect(() => setAnthropicCustomHeader(
      env,
      LAUNCH_TICKET_HEADER,
      'ticket\nx-injected: unsafe',
    )).toThrow(`Invalid ${LAUNCH_TICKET_HEADER} header value`);
  });

  it('no live server: returns the env untouched without mutating the input', () => {
    const env = computeWrapperEnv(baseEnv, null);

    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);
  });

  it('stale-pid server state resolves to null and leaves the env untouched', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'clodex-wrapper-test-'));
    try {
      const homeEnv = { CLODEX_HOME: join(tempHome, 'app-home') };
      registerServerRuntimeState({
        mode: 'proxy',
        port: 17645,
        pid: 999999,
        caPath: '/tmp/ca.pem',
        startedAt: '2026-07-20T00:00:00.000Z',
      }, homeEnv, { isAlive: () => true });

      const state = readLiveServerRuntimeState(homeEnv, { isAlive: () => false });
      const env = computeWrapperEnv(baseEnv, state);

      expect(state).toBeNull();
      expect(env).toEqual(baseEnv);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('requires a live server only when explicitly enabled', () => {
    expect(wrapperRequiresServer({})).toBe(false);
    expect(wrapperRequiresServer({ CLODEX_REQUIRE_SERVER: '0' })).toBe(false);
    expect(wrapperRequiresServer({ CLODEX_REQUIRE_SERVER: '1' })).toBe(true);
  });
});
