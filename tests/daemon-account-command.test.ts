import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

import { loginProviderAccount } from '../src/daemon/account-command.js';
import { DaemonAccountStore } from '../src/daemon/account-store.js';
import {
  CREDENTIAL_HELPER_ENV,
  credentialInstanceAuthRef,
} from '../src/credentials/helper.js';
import { resolveProviderCredential } from '../src/config/environment.js';
import { asMocked, type JsonObject } from './test-helpers.js';

const helperPath = fileURLToPath(new URL('./fixtures/credential-helper.mjs', import.meta.url));
const originalFetch = global.fetch;
let root = '';

function jwt(claims: JsonObject): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clodex-account-command-'));
  process.env.CLODEX_HOME = root;
  process.env[CREDENTIAL_HELPER_ENV] = helperPath;
  process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE = join(root, 'credentials.json');
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.CLODEX_HOME;
  delete process.env[CREDENTIAL_HELPER_ENV];
  delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE;
  rmSync(root, { recursive: true, force: true });
});

describe('managed account sign-in', () => {
  it('reprovisions an account whose stored credential is missing', async () => {
    const store = new DaemonAccountStore();
    store.add({
      id: 'selected-id',
      label: 'selected@example.com',
      email: 'selected@example.com',
      authRef: 'none:anonymous',
    });
    const stale = store.add({
      id: 'stale-id',
      label: 'person@example.com',
      email: 'person@example.com',
      authRef: credentialInstanceAuthRef('oauth:provider:openai-oauth'),
    });
    const accessToken = jwt({
      email: 'person@example.com',
      chatgpt_account_id: 'account-1',
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });
    asMocked(global.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'device-auth',
        user_code: 'device-code',
        interval: '1',
        expires_in: 60,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'authorization-code',
        code_verifier: 'verifier',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: accessToken,
        refresh_token: 'refresh-token',
        expires_in: 3_600,
      }), { status: 200 }));

    await expect(loginProviderAccount('openai-oauth')).resolves.toEqual({
      id: stale.id,
      email: 'person@example.com',
      providerId: 'openai-oauth',
    });

    const repaired = store.list().find(account => account.id === stale.id)!;
    expect(repaired.authRef).toContain('oauth:provider:openai-oauth:account:stale-id');
    expect(repaired.email).toBe('person@example.com');
    expect(repaired.accountId).toBe('account-1');
    expect(await resolveProviderCredential('openai-oauth', repaired.authRef)).toBe(accessToken);
    await expect(resolveProviderCredential('openai-oauth', stale.authRef))
      .resolves.toBeNull();
  });
});
