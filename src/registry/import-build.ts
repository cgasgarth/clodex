// import-build.ts — registry auth-ref helpers for OAuth providers

import { credentialAuthRef } from '../credentials/helper.js';

export function oauthAuthRef(providerId: string): string {
  return credentialAuthRef(`oauth:provider:${providerId}`);
}

/** Maps a canonical OAuth provider ID to its registry slot. */
export function toOAuthRegistryId(id: string): string {
  if (id === 'openai') return 'openai-oauth';
  if (id === 'xai') return 'xai-oauth';
  return id;
}

export function oauthTemplateId(id: string): string {
  const registryId = toOAuthRegistryId(id);
  return registryId === 'openai-oauth' ? 'openai' : registryId;
}
