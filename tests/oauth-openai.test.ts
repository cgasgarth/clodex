import { afterEach, describe, expect, it, vi } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { refreshOpenAiAccessToken, validateChatGptTokens, runOpenAiSignIn } from '../src/oauth/openai.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalFetch = global.fetch;
const originalHome = process.env.CLODEX_HOME;
const keys = await generateKeyPair('ES256');
const publicKey = await exportJWK(keys.publicKey);
const localJwks = createLocalJWKSet({ keys: [{ ...publicKey, kid: 'test', alg: 'ES256' }] });
const scope = 'openid email offline_access resource.invoke chatgpt.tokens.use.direct';
const home = mkdtempSync(join(tmpdir(), 'clodex-siwc-test-'));

async function idToken(nonce: string, audience = 'oaiapp_test') {
  return new SignJWT({ nonce, email: 'test@example.com' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer('https://auth.openai.com').setAudience(audience).setSubject('user_test')
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
}

afterEach(() => {
  global.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.CLODEX_HOME;
  else process.env.CLODEX_HOME = originalHome;
});

describe('ChatGPT plan sign-in', () => {
  it('validates a signed identity, audience, nonce, and plan grant', async () => {
    const token = await idToken('nonce');
    const result = await validateChatGptTokens({ access_token: 'access', id_token: token, scope }, 'oaiapp_test', 'nonce', localJwks);
    expect(result.sub).toBe('user_test');
    await expect(validateChatGptTokens({ access_token: 'access', id_token: token, scope }, 'oaiapp_test', 'wrong', localJwks)).rejects.toThrow('validation failed');
    await expect(validateChatGptTokens({ access_token: 'access', id_token: token, scope }, 'other_client', 'nonce', localJwks)).rejects.toThrow();
  });

  it('requires the granted ChatGPT plan permission', async () => {
    await expect(validateChatGptTokens({ access_token: 'access', id_token: await idToken('nonce'), scope: 'openid email' }, 'oaiapp_test', 'nonce', localJwks)).rejects.toThrow('not approved');
  });

  it('completes dynamic registration through a real loopback callback', async () => {
    process.env.CLODEX_HOME = home;
    let authorization: URL;
    let callbackRequest: Promise<Response> | undefined;
    let exchange: URLSearchParams | undefined;
    global.fetch = Object.assign(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [{ ...publicKey, kid: 'test', alg: 'ES256' }] });
      exchange = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: 'access', refresh_token: 'refresh', scope,
        id_token: await idToken(authorization.searchParams.get('nonce')!) });
    }), { preconnect: originalFetch.preconnect });
    const result = await runOpenAiSignIn(({ url }) => {
      authorization = new URL(url);
      expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(authorization.searchParams.get('agent_name_hint')).toBe('Clodex');
      expect(authorization.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
      const callback = new URL(authorization.searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe('127.0.0.1');
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'code', client_id: 'oaiapp_test' }).toString();
      callbackRequest = originalFetch(callback);
    });
    await callbackRequest;
    expect(result.providerData.clientId).toBe('oaiapp_test');
    expect(result.email).toBe('test@example.com');
    expect(exchange?.get('client_id')).toBe('oaiapp_test');
    expect(exchange?.get('resource')).toBe('https://api.openai.com/v1');
    rmSync(home, { recursive: true, force: true });
  });

  it('refreshes with the account registration and public resource', async () => {
    const request = vi.fn(async () => Response.json({ access_token: 'renewed', refresh_token: 'rotated', scope }));
    global.fetch = Object.assign(request, { preconnect: originalFetch.preconnect });
    const result = await refreshOpenAiAccessToken('refresh', { clientId: 'oaiapp_test' });
    expect(result.refresh_token).toBe('rotated');
    expect(String(request.mock.calls[0]?.[0])).toBe('https://auth.openai.com/api/accounts/oauth/token');
  });
});
