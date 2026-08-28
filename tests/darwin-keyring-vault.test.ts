import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'bun:test';
import { createHoisted } from './test-helpers.js';

const keyring = createHoisted(() => ({
  values: new Map<string, string>(),
  findCount: 0,
  getCount: 0,
  setCount: 0,
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    private readonly key: string;

    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }

    getPassword(): string | null {
      keyring.getCount++;
      return keyring.values.get(this.key) ?? null;
    }

    setPassword(value: string): void {
      keyring.setCount++;
      keyring.values.set(this.key, value);
    }

    deletePassword(): boolean {
      return keyring.values.delete(this.key);
    }
  },
  findCredentials: (service: string) => {
    keyring.findCount++;
    const prefix = `${service}:`;
    return [...keyring.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, password]) => ({ account: key.slice(prefix.length), password }));
  },
}));

vi.mock('../src/credentials/keyring/platform.js', () => ({
  usesDarwinCredentialVault: () => true,
}));

import {
  deleteProviderCredential,
  probeProviderCredentialStore,
  provisionProviderCredential,
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/config/environment.js';

const instance = `v1:${'1'.repeat(32)}`;
const firstAccount = `provider:first::credential::${instance}`;
const secondAccount = `provider:second::credential::${instance}`;
const firstRef = `keyring:${firstAccount}`;
const secondRef = `keyring:${secondAccount}`;
const vaultKey = 'clodex:credential-vault:v1';
const previousCredentialHome = process.env.CLODEX_CREDENTIAL_HOME;
let tempDir = '';

function vaultCredentials(): Record<string, string | null> {
  const raw = keyring.values.get(vaultKey);
  expect(raw).toBeDefined();
  // SAFETY: The production encoder and the assertion above establish this fixture shape.
  return JSON.parse(raw!).credentials as Record<string, string | null>;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clodex-darwin-vault-'));
  process.env.CLODEX_CREDENTIAL_HOME = tempDir;
  keyring.values.clear();
  keyring.findCount = 0;
  keyring.getCount = 0;
  keyring.setCount = 0;
});

afterEach(() => {
  if (previousCredentialHome === undefined) delete process.env.CLODEX_CREDENTIAL_HOME;
  else process.env.CLODEX_CREDENTIAL_HOME = previousCredentialHome;
  rmSync(tempDir, { recursive: true, force: true });
});

it('stores every macOS credential in one Keychain item without enumeration', async () => {
  const first = 'a'.repeat(8_000);
  const second = 'b'.repeat(6_000);

  await expect(provisionProviderCredential(firstRef, first)).resolves.toBe(true);
  await expect(provisionProviderCredential(secondRef, second)).resolves.toBe(true);

  expect([...keyring.values.keys()]).toEqual([vaultKey]);
  expect(vaultCredentials()).toEqual({
    [firstAccount]: first,
    [secondAccount]: second,
  });
  await expect(resolveProviderCredential('first', firstRef)).resolves.toBe(first);
  await expect(resolveProviderCredential('second', secondRef)).resolves.toBe(second);
  expect(keyring.findCount).toBe(0);
});

it('replaces and deletes credentials while retaining the permission-bearing item', async () => {
  await expect(provisionProviderCredential(firstRef, 'first-secret')).resolves.toBe(true);
  await expect(saveProviderCredential(firstRef, 'replacement-secret')).resolves.toBe(true);
  await expect(resolveProviderCredential('first', firstRef)).resolves.toBe('replacement-secret');

  await expect(deleteProviderCredential(firstRef)).resolves.toBe(true);
  await expect(resolveProviderCredential('first', firstRef)).resolves.toBeNull();

  expect([...keyring.values.keys()]).toEqual([vaultKey]);
  expect(vaultCredentials()).toEqual({ [firstAccount]: null });
  expect(keyring.findCount).toBe(0);
});

it('fails closed when the shared vault is malformed', async () => {
  const diagnostics: string[] = [];
  keyring.values.set(vaultKey, '{bad json');

  await expect(
    resolveProviderCredential('first', firstRef, message => diagnostics.push(message)),
  ).resolves.toBeNull();
  await expect(
    provisionProviderCredential(firstRef, 'secret', message => diagnostics.push(message)),
  ).resolves.toBe(false);

  expect(keyring.values.get(vaultKey)).toBe('{bad json');
  expect(diagnostics.join('\n')).toContain('keyring credential vault is invalid');
  expect(keyring.findCount).toBe(0);
});

it('does not enumerate legacy entries when the managed vault becomes unavailable', async () => {
  await expect(provisionProviderCredential(firstRef, 'secret')).resolves.toBe(true);
  keyring.values.clear();

  await expect(resolveProviderCredential('first', firstRef)).resolves.toBeNull();
  await expect(provisionProviderCredential(secondRef, 'second-secret')).resolves.toBe(false);
  await expect(deleteProviderCredential(firstRef)).resolves.toBe(false);

  expect(keyring.findCount).toBe(0);
  expect(keyring.values.size).toBe(0);
});

it('removes disposable probes without deleting the shared vault item', async () => {
  await expect(probeProviderCredentialStore(firstRef)).resolves.toBe(true);

  expect([...keyring.values.keys()]).toEqual([vaultKey]);
  expect(vaultCredentials()).toEqual({});
  expect(keyring.findCount).toBe(0);
});

it('moves a legacy credential into the vault and removes its old Keychain items', async () => {
  keyring.values.set(`clodex:${firstAccount}`, 'legacy-secret');

  await expect(resolveProviderCredential('first', firstRef)).resolves.toBe('legacy-secret');

  expect([...keyring.values.keys()]).toEqual([vaultKey]);
  expect(vaultCredentials()).toEqual({ [firstAccount]: 'legacy-secret' });
  const migrationFindCount = keyring.findCount;
  await expect(resolveProviderCredential('first', firstRef)).resolves.toBe('legacy-secret');
  expect(keyring.findCount).toBe(migrationFindCount);
});
