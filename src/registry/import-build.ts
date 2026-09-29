// import-build.ts — registry auth-ref helpers for OAuth providers

import { credentialAuthRef } from '../credentials/helper.js';

export function oauthAuthRef(providerId: string): string {
  return credentialAuthRef(`oauth:provider:${providerId}`);
}
