// oauth/types.ts — stored OAuth credential shape (keychain JSON)

import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import type { ProviderDataValue } from '../types.js';

export interface StoredOAuthCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  /** Epoch millis when the access token expires. */
  expires: number;
  accessRejected?: true;
  accountId?: string;
  providerData?: Record<string, ProviderDataValue>;
}

/** Serialize a stored OAuth credential for the keychain. */
export function oauthCredentialToKeychainJson(cred: StoredOAuthCredential): string {
  return JSON.stringify(cred);
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

export function tokensToStoredCredential(
  tokens: OAuthTokenResponse,
  existingRefresh?: string,
  accountId?: string,
  providerData?: Record<string, ProviderDataValue>,
): StoredOAuthCredential {
  const access = isString(tokens.access_token) ? tokens.access_token.trim() : '';
  if (!access) {
    throw new Error('OAuth token response is missing a valid access token');
  }

  if (
    tokens.expires_in !== undefined
    && (
      !isNumber(tokens.expires_in)
      || !Number.isFinite(tokens.expires_in)
      || tokens.expires_in < 0
    )
  ) {
    throw new Error('OAuth token response has an invalid expiration');
  }

  const returnedRefresh = isString(tokens.refresh_token) ? tokens.refresh_token.trim() : '';
  const expires = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  if (!Number.isFinite(expires)) {
    throw new Error('OAuth token response has an invalid expiration');
  }
  return {
    type: 'oauth',
    access,
    refresh: returnedRefresh || existingRefresh || '',
    expires,
    ...(accountId && { accountId }),
    ...(providerData && { providerData }),
  };
}

export function parseStoredOAuthCredential(raw: string | null): StoredOAuthCredential | null {
  if (!raw?.trim().startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed)) {
      // SAFETY: JSON object fields remain ProviderDataValue until each required field is checked.
      const credential = parsed as Record<string, ProviderDataValue>;
      if (credential.type === 'oauth'
        && isString(credential.access)
        && credential.access.trim().length > 0
        && isString(credential.refresh)
        && isNumber(credential.expires)
        && Number.isFinite(credential.expires)
        && (credential.accessRejected === undefined || credential.accessRejected === true)
        && (credential.accountId === undefined || isString(credential.accountId))
        && (credential.providerData === undefined || isObject(credential.providerData))) {
        // SAFETY: The checks above establish every stored credential field contract.
        const checkedProviderData = credential.providerData as Record<string, ProviderDataValue> | undefined;
        return {
          type: 'oauth',
          access: credential.access,
          refresh: credential.refresh,
          expires: credential.expires,
          ...(credential.accessRejected === true && { accessRejected: true }),
          ...(credential.accountId && { accountId: credential.accountId }),
          ...(checkedProviderData && { providerData: checkedProviderData }),
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const OAUTH_REFRESH_SKEW_MS = 120_000;

export function oauthCredentialNeedsRefresh(
  cred: Pick<StoredOAuthCredential, 'expires'>,
  skewMs = OAUTH_REFRESH_SKEW_MS,
): boolean {
  return cred.expires <= Date.now() + Math.max(0, skewMs);
}

/** JWT exp claim — best-effort; opaque tokens return false (no proactive refresh). */
export function accessTokenIsExpiring(token: string | undefined, skewMs = OAUTH_REFRESH_SKEW_MS): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    let payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) payload += '=';
    const claims: { exp?: ProviderDataValue } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (!isNumber(claims.exp)) return false;
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

const NATIVE_OAUTH_PROVIDER_IDS = ['openai', 'openai-oauth', 'xai', 'xai-oauth'] as const;
export type NativeOAuthProviderId = typeof NATIVE_OAUTH_PROVIDER_IDS[number];

export function supportsNativeOAuth(providerId: string): providerId is NativeOAuthProviderId {
  return NATIVE_OAUTH_PROVIDER_IDS.some(candidate => candidate === providerId);
}
