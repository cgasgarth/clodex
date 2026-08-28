import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getCredentialStateRoot } from '../../registry/lock.js';
import { isObject, isString } from '../../runtime/type-guards.js';
import { KEYRING_SERVICE, type KeyringApi } from './base.js';

export const KEYRING_VAULT_ACCOUNT = 'credential-vault:v1';
const KEYRING_VAULT_VERSION = 1;
const MAX_VAULT_CREDENTIALS = 1_024;
const MAX_VAULT_BYTES = 8 * 1024 * 1024;

interface KeyringVault {
  version: typeof KEYRING_VAULT_VERSION;
  credentials: Record<string, string | null>;
}

interface KeyringVaultAccount {
  exists: boolean;
  known: boolean;
  value: string | null;
}

const KEYRING_VAULT_MARKER = 'v1:managed\n';

function keyringVaultMarkerPath(): string {
  return join(getCredentialStateRoot(), 'darwin-vault-v1.managed');
}

export function keyringVaultIsManaged(): boolean {
  const path = keyringVaultMarkerPath();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('macOS keychain vault marker is not a regular file');
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && stat.uid !== currentUid) {
      throw new Error('macOS keychain vault marker is owned by another user');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('macOS keychain vault marker permissions are too broad');
    }
    if (stat.size !== Buffer.byteLength(KEYRING_VAULT_MARKER)) {
      throw new Error('macOS keychain vault marker is invalid');
    }
    if (readFileSync(path, 'utf8') !== KEYRING_VAULT_MARKER) {
      throw new Error('macOS keychain vault marker is invalid');
    }
    return true;
  } catch (error) {
    if (isObject(error) && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function markKeyringVaultManaged(): void {
  const root = getCredentialStateRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = keyringVaultMarkerPath();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(fd, KEYRING_VAULT_MARKER, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
  if (!keyringVaultIsManaged()) {
    throw new Error('macOS keychain vault marker could not be verified');
  }
}

function emptyKeyringVault(): KeyringVault {
  return { version: KEYRING_VAULT_VERSION, credentials: {} };
}

function parseKeyringVault(raw: string | null): KeyringVault | null {
  if (raw === null) return null;
  if (Buffer.byteLength(raw) > MAX_VAULT_BYTES) {
    throw new Error('keyring credential vault is too large');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('keyring credential vault is invalid', { cause: error });
  }
  if (
    !isObject(value)
    || !('version' in value)
    || value.version !== KEYRING_VAULT_VERSION
    || !('credentials' in value)
    || !isObject(value.credentials)
  ) {
    throw new Error('keyring credential vault is invalid');
  }
  const entries = Object.entries(value.credentials);
  if (entries.length > MAX_VAULT_CREDENTIALS) {
    throw new Error('keyring credential vault has too many entries');
  }
  const credentials: Record<string, string | null> = {};
  for (const [account, credential] of entries) {
    if (!account || (credential !== null && (!isString(credential) || !credential))) {
      throw new Error('keyring credential vault is invalid');
    }
    credentials[account] = credential;
  }
  return { version: KEYRING_VAULT_VERSION, credentials };
}

function encodeKeyringVault(vault: KeyringVault): string {
  const credentials = Object.fromEntries(
    Object.entries(vault.credentials).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const encoded = JSON.stringify({ version: KEYRING_VAULT_VERSION, credentials });
  if (Buffer.byteLength(encoded) > MAX_VAULT_BYTES) {
    throw new Error('keyring credential vault is too large');
  }
  return encoded;
}

function readKeyringVault(keyring: KeyringApi): KeyringVault | null {
  const raw = new keyring.Entry(KEYRING_SERVICE, KEYRING_VAULT_ACCOUNT).getPassword();
  return parseKeyringVault(raw);
}

function writeKeyringVault(keyring: KeyringApi, vault: KeyringVault): void {
  const encoded = encodeKeyringVault(vault);
  const entry = new keyring.Entry(KEYRING_SERVICE, KEYRING_VAULT_ACCOUNT);
  entry.setPassword(encoded);
  if (entry.getPassword() !== encoded) {
    throw new Error('keyring credential vault write verification failed');
  }
  markKeyringVaultManaged();
}

function hasActiveCredential(vault: KeyringVault, account: string): boolean {
  return isString(vault.credentials[account]);
}

export function readKeyringVaultAccount(
  keyring: KeyringApi,
  account: string,
): KeyringVaultAccount {
  const vault = readKeyringVault(keyring);
  return {
    exists: vault !== null,
    known: vault !== null && Object.hasOwn(vault.credentials, account),
    value: vault?.credentials[account] ?? null,
  };
}

export function writeKeyringVaultAccount(
  keyring: KeyringApi,
  account: string,
  value: string,
  requireExisting: boolean,
): boolean {
  const vault = readKeyringVault(keyring) ?? emptyKeyringVault();
  if (requireExisting && !hasActiveCredential(vault, account)) return false;
  vault.credentials[account] = value;
  writeKeyringVault(keyring, vault);
  return true;
}

export function provisionKeyringVaultAccount(
  keyring: KeyringApi,
  account: string,
  value: string,
): boolean {
  const vault = readKeyringVault(keyring) ?? emptyKeyringVault();
  if (hasActiveCredential(vault, account)) return false;
  vault.credentials[account] = value;
  writeKeyringVault(keyring, vault);
  return true;
}

export function deleteKeyringVaultAccount(
  keyring: KeyringApi,
  account: string,
  retainTombstone: boolean,
): boolean {
  const vault = readKeyringVault(keyring);
  if (!vault || !hasActiveCredential(vault, account)) return false;
  if (retainTombstone) vault.credentials[account] = null;
  else delete vault.credentials[account];
  // Keep the empty item so its macOS access decision remains stable for future credentials.
  writeKeyringVault(keyring, vault);
  return true;
}
