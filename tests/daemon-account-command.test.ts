import { importActual } from './bun-import-actual.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'bun:test';
import { CREDENTIAL_HELPER_ENV } from '../src/credentials/helper.js';

const access = `e30.${Buffer.from(JSON.stringify({scope: 'chatgpt.tokens.use.direct'})).toString('base64url')}.signature`;
const metadata = {clientId: 'oaiapp_test', subject: 'user_test', idToken: 'verified-fixture', scope: 'chatgpt.tokens.use.direct'};
vi.mock('open', () => ({default: vi.fn(async () => undefined)}));
vi.mock('../src/oauth/openai.js', () => ({
  ...importActual<typeof import('../src/oauth/openai.js')>('../src/oauth/openai.js', import.meta.url),
  runOpenAiSignIn: vi.fn(async () => ({tokens: {access_token: access, refresh_token: 'refresh', expires_in: 3600},
    accountId: 'oaiapp_test', email: 'user@example.com', providerData: metadata})),
}));
vi.mock('../src/registry/refresh-models.js', () => ({refreshProviderModels: vi.fn(async () => ({ok: true}))}));
import { loginProviderAccount } from '../src/daemon/account-command.js';
import { DaemonAccountStore } from '../src/daemon/account-store.js';
import { readProviderOAuthCredential } from '../src/config/environment.js';

const root = mkdtempSync(join(tmpdir(), 'clodex-account-sign-in-'));
const previousHome = process.env.CLODEX_HOME;
const previousHelper = process.env[CREDENTIAL_HELPER_ENV];
process.env.CLODEX_HOME = root;
process.env[CREDENTIAL_HELPER_ENV] = fileURLToPath(new URL('./fixtures/credential-helper.mjs', import.meta.url));
process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE = join(root, 'credentials.json');
afterEach(() => {
  if(previousHome === undefined)delete process.env.CLODEX_HOME;else process.env.CLODEX_HOME=previousHome;
  if(previousHelper === undefined)delete process.env[CREDENTIAL_HELPER_ENV];else process.env[CREDENTIAL_HELPER_ENV]=previousHelper;
  delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE;
  rmSync(root, {recursive: true, force: true});
});

it('persists and selects the authorized Clodex registration', async () => {
  const result = await loginProviderAccount('openai-oauth');
  const selected = new DaemonAccountStore().selected('openai-oauth');
  expect(selected?.id).toBe(result.id);
  expect(selected?.accountId).toBe('oaiapp_test');
  const credential = await readProviderOAuthCredential(selected!.authRef);
  expect(credential?.access).toBe(access);
  expect(credential?.providerData).toEqual(metadata);
});
