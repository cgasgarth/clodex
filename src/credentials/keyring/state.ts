import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  getCredentialStateRoot,
} from '../../registry/lock.js';
import { KEYRING_MANAGED_STATE_KEY_SERVICE, KEYRING_MANAGED_STATE_KEY_PREFIX, readKeyringEntry } from './base.js';
import type { KeyringChunkJournal, KeyringApi } from './base.js';
import { parseKeyringChunkJournal, encodeKeyringJournal } from './codec.js';

const KEYRING_PREPARING_STATE_PREFIX = 'v2:preparing:';
const KEYRING_MANAGED_STATE_PREFIX = 'v2:managed:';
const KEYRING_EMPTY_MANAGED_STATE_VALUE = 'v1:managed\n';
export type KeyringManagedState =
  | { mode: 'preparing'; journal: KeyringChunkJournal }
  | { mode: 'managed'; journal: KeyringChunkJournal | null };

export class KeyringManagedStateKeyUnavailableError extends Error {
  constructor() {
    super('keyring managed-state encryption key is unavailable');
    this.name = 'KeyringManagedStateKeyUnavailableError';
  }
}

function keyringAccountIdentity(account: string): string {
  return createHash('sha256').update(account).digest('hex');
}

function keyringManagedStatePath(account: string): string {
  return join(getCredentialStateRoot(), `${keyringAccountIdentity(account)}.managed`);
}

function parseKeyringManagedStateKey(value: string): Buffer {
  if (!value.startsWith(KEYRING_MANAGED_STATE_KEY_PREFIX)) {
    throw new KeyringManagedStateKeyUnavailableError();
  }
  const encoded = value.slice(KEYRING_MANAGED_STATE_KEY_PREFIX.length);
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) {
    throw new KeyringManagedStateKeyUnavailableError();
  }
  return key;
}

function readKeyringManagedStateKey(keyring: KeyringApi, account: string): Buffer | null {
  const value = readKeyringEntry(keyring, KEYRING_MANAGED_STATE_KEY_SERVICE, account);
  return value === null ? null : parseKeyringManagedStateKey(value);
}

function ensureKeyringManagedStateKey(keyring: KeyringApi, account: string): Buffer {
  let current: Buffer | null;
  try {
    current = readKeyringManagedStateKey(keyring, account);
  } catch (err) {
    if (!(err instanceof KeyringManagedStateKeyUnavailableError)) throw err;
    current = null;
  }
  if (current !== null) return current;
  const key = randomBytes(32);
  const encoded = `${KEYRING_MANAGED_STATE_KEY_PREFIX}${key.toString('base64url')}`;
  const entry = new keyring.Entry(KEYRING_MANAGED_STATE_KEY_SERVICE, account);
  entry.setPassword(encoded);
  if (readKeyringEntry(keyring, KEYRING_MANAGED_STATE_KEY_SERVICE, account) !== encoded) {
    throw new Error('keyring managed-state encryption key verification failed');
  }
  return key;
}

function keyringManagedStateAad(account: string, mode: KeyringManagedState['mode']): Buffer {
  return Buffer.from(`clodex-managed-state:v2:${mode}:${account}`, 'utf8');
}

function decryptKeyringManagedState(
  key: Buffer,
  account: string,
  mode: KeyringManagedState['mode'],
  encoded: string,
): KeyringChunkJournal {
  const payload = Buffer.from(encoded, 'base64url');
  if (payload.toString('base64url') !== encoded || payload.length <= 28) {
    throw new Error('keyring managed-state marker is invalid');
  }
  const nonce = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(keyringManagedStateAad(account, mode));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return parseKeyringChunkJournal(plaintext);
}

export function readKeyringManagedState(
  keyring: KeyringApi,
  account: string,
): KeyringManagedState | null {
  try {
    const value = readFileSync(keyringManagedStatePath(account), 'utf8');
    if (value === KEYRING_EMPTY_MANAGED_STATE_VALUE) {
      return { mode: 'managed', journal: null };
    }
    const statePrefix = value.startsWith(KEYRING_PREPARING_STATE_PREFIX)
      ? KEYRING_PREPARING_STATE_PREFIX
      : value.startsWith(KEYRING_MANAGED_STATE_PREFIX)
        ? KEYRING_MANAGED_STATE_PREFIX
        : null;
    if (statePrefix && value.endsWith('\n')) {
      try {
        const mode = statePrefix === KEYRING_PREPARING_STATE_PREFIX ? 'preparing' : 'managed';
        const key = readKeyringManagedStateKey(keyring, account);
        if (key === null) {
          throw new KeyringManagedStateKeyUnavailableError();
        }
        const journal = decryptKeyringManagedState(
          key,
          account,
          mode,
          value.slice(statePrefix.length, -1),
        );
        return mode === 'preparing'
          ? { mode: 'preparing', journal }
          : { mode: 'managed', journal };
      } catch (err) {
        if (err instanceof KeyringManagedStateKeyUnavailableError) throw err;
        throw new Error('keyring managed-state marker is invalid');
      }
    }
    throw new Error('keyring managed-state marker is invalid');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function sameKeyringManagedState(
  left: KeyringManagedState,
  right: KeyringManagedState,
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.journal === null || right.journal === null) {
    return left.journal === right.journal;
  }
  return encodeKeyringJournal(left.journal) === encodeKeyringJournal(right.journal);
}

function encodeKeyringManagedState(
  keyring: KeyringApi,
  account: string,
  state: KeyringManagedState,
): string {
  if (state.mode === 'managed' && state.journal === null) {
    return KEYRING_EMPTY_MANAGED_STATE_VALUE;
  }
  const journal = state.journal;
  if (journal === null) return KEYRING_EMPTY_MANAGED_STATE_VALUE;
  const key = ensureKeyringManagedStateKey(keyring, account);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(keyringManagedStateAad(account, state.mode));
  const ciphertext = Buffer.concat([
    cipher.update(encodeKeyringJournal(journal), 'utf8'),
    cipher.final(),
  ]);
  const payload = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  const prefix =
    state.mode === 'preparing' ? KEYRING_PREPARING_STATE_PREFIX : KEYRING_MANAGED_STATE_PREFIX;
  return `${prefix}${payload}\n`;
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') {
      throw err;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function persistKeyringManagedState(
  keyring: KeyringApi,
  account: string,
  state: KeyringManagedState,
): void {
  const currentState = readKeyringManagedState(keyring, account);
  if (currentState !== null && sameKeyringManagedState(currentState, state)) return;
  const encodedState = encodeKeyringManagedState(keyring, account, state);
  const path = keyringManagedStatePath(account);
  const directory = getCredentialStateRoot();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, encodedState, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      renameSync(tempPath, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') {
        throw err;
      }
      unlinkSync(path);
      renameSync(tempPath, path);
    }
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export function removeKeyringManagedState(account: string): void {
  const path = keyringManagedStatePath(account);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  syncDirectory(getCredentialStateRoot());
}
