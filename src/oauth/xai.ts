// xai.ts — native SuperGrok OAuth device-code flow

import { VERSION } from '../constants.js';
import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import { positiveSecondsToMs, sleepMs } from './pkce.js';
import { postOAuthRefresh } from './refresh-http.js';
import type { OAuthTokenResponse } from './types.js';
import type { JsonObject } from './responses-websocket/types.js';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ISSUER = 'https://auth.x.ai';
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SCOPE = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
  'workspaces:read',
  'workspaces:write',
].join(' ');
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;

interface XaiDeviceCodeData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in?: number;
  interval?: number;
}

interface XaiOAuthError {
  error?: string;
}

interface XaiOAuthHeaders {
  [key: string]: string;
}

function isJsonObject<Value>(value: Value): value is Value & JsonObject {
  return isObject(value) && !Array.isArray(value);
}

function oauthHeaders(): XaiOAuthHeaders {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': `clodex/${VERSION}`,
    'X-Grok-Client-Version': VERSION,
    'X-Grok-Client-Surface': process.stdin.isTTY && process.stdout.isTTY ? 'cli' : 'headless',
  };
}

function assertDeviceCodeData<Value>(value: Value): XaiDeviceCodeData {
  if (!isJsonObject(value)) {
    throw new Error('xAI device authorization returned an invalid response');
  }
  const data = value;
  if (
    !isString(data.device_code)
    || !data.device_code
    || !isString(data.user_code)
    || !data.user_code
    || !isString(data.verification_uri)
  ) {
    throw new Error('xAI device authorization returned an invalid response');
  }
  const verificationUrl = new URL(data.verification_uri);
  if (
    verificationUrl.protocol !== 'https:'
    || !['auth.x.ai', 'accounts.x.ai'].includes(verificationUrl.hostname)
    || verificationUrl.username
    || verificationUrl.password
  ) {
    throw new Error('xAI device authorization returned an untrusted verification URL');
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: isNumber(data.expires_in) ? data.expires_in : undefined,
    interval: isNumber(data.interval) ? data.interval : undefined,
  };
}

async function requestXaiDeviceCode(): Promise<XaiDeviceCodeData> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: oauthHeaders(),
    redirect: 'error',
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: 'clodex',
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`xAI device authorization failed (${response.status})`);
  }
  return assertDeviceCodeData(await response.json());
}

async function pollXaiDeviceCodeToken(
  device: XaiDeviceCodeData,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<OAuthTokenResponse> {
  const sleep = opts?.sleep ?? sleepMs;
  const now = opts?.now ?? Date.now;
  let intervalMs = Math.max(device.interval ?? DEFAULT_INTERVAL_SECONDS, 1) * 1000;
  const deadline = now() + positiveSecondsToMs(device.expires_in, DEFAULT_EXPIRES_MS);

  while (now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: oauthHeaders(),
      redirect: 'error',
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: device.device_code,
        client_id: CLIENT_ID,
      }).toString(),
    });
    // SAFETY: The OAuth token endpoint returns the documented token/error envelope.
    const body = await response.json().catch(() => ({})) as OAuthTokenResponse & XaiOAuthError;
    if (response.ok) return body;
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      intervalMs += SLOW_DOWN_SECONDS * 1000;
      continue;
    }
    if (body.error === 'access_denied' || body.error === 'authorization_denied') {
      throw new Error('xAI device authorization was denied');
    }
    if (body.error === 'expired_token') break;
    throw new Error(`xAI device authorization failed (${response.status})`);
  }
  throw new Error('xAI device authorization timed out');
}

export async function refreshXaiAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  return postOAuthRefresh(
    TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    {
      contentType: 'form',
      errorPrefix: 'xAI token refresh failed',
      includeStatus: true,
      headers: oauthHeaders(),
    },
  );
}

export async function runXaiDeviceCodeFlow(
  onDeviceCode: (info: { url: string; userCode: string }) => void,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ tokens: OAuthTokenResponse; accountId?: string }> {
  const device = await requestXaiDeviceCode();
  onDeviceCode({ url: device.verification_uri, userCode: device.user_code });
  return { tokens: await pollXaiDeviceCodeToken(device, opts) };
}
