// oauth/refresh.ts — refresh OAuth tokens before inference

import { refreshOpenAiAccessToken } from './openai.js';
import { refreshXaiAccessToken } from './xai.js';
import type { StoredOAuthCredential } from './types.js';
import { accessTokenIsExpiring, oauthCredentialNeedsRefresh, supportsNativeOAuth, tokensToStoredCredential } from './types.js';

export function oauthCredentialShouldRefresh(
  cred: Pick<StoredOAuthCredential, 'access' | 'expires'>,
  providerId: string,
): boolean {
  if (oauthCredentialNeedsRefresh(cred)) return true;
  // All native OAuth providers use short-lived access tokens — check expiry proactively
  if (supportsNativeOAuth(providerId) && accessTokenIsExpiring(cred.access)) return true;
  return false;
}

export async function refreshStoredOAuthCredential(
  providerId: string,
  cred: StoredOAuthCredential,
): Promise<StoredOAuthCredential> {
  if (!cred.refresh) {
    throw new Error(`${providerId}: OAuth refresh token missing — run clodex providers auth ${providerId}`);
  }

  let tokens;
  if (providerId === 'openai' || providerId === 'openai-oauth') {
    tokens = await refreshOpenAiAccessToken(cred.refresh);
  } else if (providerId === 'xai' || providerId === 'xai-oauth') {
    tokens = await refreshXaiAccessToken(cred.refresh);
  } else {
    throw new Error(`OAuth refresh not implemented for provider "${providerId}"`);
  }

  return tokensToStoredCredential(tokens, cred.refresh, cred.accountId, cred.providerData);
}
