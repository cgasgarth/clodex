// Sign in with ChatGPT for open-source, locally hosted apps.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { getAppHome } from '../config/paths.js';
import { isString } from '../runtime/type-guards.js';
import type { ProviderDataValue } from '../types.js';
import type { OAuthTokenResponse } from './types.js';
import { postOAuthRefresh } from './refresh-http.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export interface OpenAiRegistration {
  clientId: string;
  subject: string;
  idToken: string;
}

export function openAiRegistrationFromData(data?: Record<string, ProviderDataValue>): OpenAiRegistration | undefined {
  if (!isString(data?.clientId) || !isString(data.subject) || !isString(data.idToken)
    || !isString(data.scope) || !data.scope.split(' ').includes('chatgpt.tokens.use.direct')) return undefined;
  return { clientId: data.clientId, subject: data.subject, idToken: data.idToken };
}

function hostId(): string {
  const home = getAppHome();
  const path = join(home, 'chatgpt-host-id');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `urn:uuid:${randomUUID()}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const id = readFileSync(path, 'utf8').trim();
  if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Clodex ChatGPT host ID');
  return id;
}

export function requireChatGptPlanToken(accessToken: string): void {
  let scope: unknown;
  try { scope = decodeJwt(accessToken).scope; } catch { /* Report the sign-in error below. */ }
  if (!isString(scope) || !scope.split(' ').includes('chatgpt.tokens.use.direct')) {
    throw new Error('ChatGPT plan permission is missing. Run clodex accounts add openai to sign in to Clodex.');
  }
}

export async function validateChatGptTokens(
  tokens: OAuthTokenResponse,
  clientId: string,
  nonce: string,
  key: JWTVerifyGetKey = jwks,
) {
  if (!isString(tokens.id_token)) throw new Error('ChatGPT sign-in did not return an ID token');
  const { payload } = await jwtVerify(tokens.id_token, key, { issuer: ISSUER, audience: clientId });
  if (payload.nonce !== nonce || !payload.sub) throw new Error('ChatGPT sign-in identity validation failed');
  if (!isString(tokens.scope) || !tokens.scope.split(' ').includes('chatgpt.tokens.use.direct')) {
    throw new Error('ChatGPT plan usage was not approved. Sign in again and allow Clodex to use your plan.');
  }
  return payload;
}

export async function runOpenAiSignIn(
  onAuthorization: (info: { url: string }) => void,
  registration?: OpenAiRegistration,
): Promise<{ tokens: OAuthTokenResponse; accountId: string; email?: string; providerData: Record<string, ProviderDataValue> }> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const callback = createServer();
  await new Promise<void>((resolve, reject) => {
    callback.once('error', reject);
    callback.listen(0, '127.0.0.1', resolve);
  });
  const address = callback.address();
  if (!address || isString(address)) throw new Error('Could not start ChatGPT sign-in callback');
  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let browserResponse: ServerResponse | undefined;
  try {
    const result = await new Promise<{ code: string; clientId: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ChatGPT sign-in timed out')), 5 * 60_000);
      callback.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== '/auth/callback' || url.searchParams.get('state') !== state) {
          response.writeHead(400).end('Invalid sign-in callback');
          return;
        }
        const clientId = url.searchParams.get('client_id') ?? registration?.clientId;
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code || !clientId || clientId === 'dynamic_agent_client'
          || (registration && clientId !== registration.clientId)) {
          response.writeHead(400).end('Sign-in was not completed. Return to Clodex.');
          reject(new Error('ChatGPT authorization was declined or the registration was incomplete'));
          return;
        }
        browserResponse = response;
        resolve({ code, clientId });
      });
      const authUrl = new URL(`${ISSUER}/api/accounts/authorize`);
      authUrl.search = new URLSearchParams({
        client_id: registration?.clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: hostId(),
        ...(registration ? { id_token_hint: registration.idToken } : { agent_name_hint: 'Clodex' }),
        response_type: 'code', redirect_uri: redirectUri, resource: RESOURCE,
        scope: SCOPES, state, nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }).toString();
      // The URL can contain an ID-token hint. Callers must not log it.
      onAuthorization({ url: authUrl.toString() });
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: result.clientId, code: result.code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`ChatGPT token exchange failed (${response.status})`);
    // SAFETY: OAuth token JSON is an untrusted boundary; identity and grant are checked below.
    const tokens = await response.json() as OAuthTokenResponse;
    const identity = await validateChatGptTokens(tokens, result.clientId, nonce);
    if (registration && identity.sub !== registration.subject) throw new Error('ChatGPT sign-in returned a different account');
    const email = isString(identity.email) ? identity.email.trim().toLowerCase() : undefined;
    browserResponse?.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorization verified. Return to Clodex and check for the Authorization saved message.');
    return {
      tokens, accountId: result.clientId, email,
      providerData: { clientId: result.clientId, subject: identity.sub!, idToken: tokens.id_token!, scope: tokens.scope!, ...(email && { email }) },
    };
  } catch (error) {
    if (browserResponse && !browserResponse.writableEnded) {
      browserResponse.writeHead(400, { 'Content-Type': 'text/plain' }).end('Clodex sign-in did not finish. See the sign-in error in Clodex and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (browserResponse && !browserResponse.writableFinished && !browserResponse.destroyed) {
      const response = browserResponse;
      await new Promise<void>(resolve => {
        response.once('finish', resolve);
        response.once('close', resolve);
      });
    }
    callback.closeAllConnections();
    await new Promise<void>(resolve => callback.close(() => resolve()));
  }
}

export async function refreshOpenAiAccessToken(
  refreshToken: string,
  data?: Record<string, ProviderDataValue>,
): Promise<OAuthTokenResponse> {
  if (!isString(data?.clientId)) throw new Error('ChatGPT credentials need a new Clodex sign-in: clodex accounts add openai');
  const tokens = await postOAuthRefresh(TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: data.clientId, resource: RESOURCE,
  }), { contentType: 'form', errorPrefix: 'ChatGPT token refresh failed', includeStatus: true });
  if (tokens.scope !== undefined && (!isString(tokens.scope) || !tokens.scope.split(' ').includes('chatgpt.tokens.use.direct'))) {
    throw new Error('ChatGPT plan permission was revoked');
  }
  return tokens;
}
