import { createHash, randomUUID } from 'node:crypto';
import { credentialAccountBase } from '../../credential-helper.js';
import {
  KEYRING_GENERATION_PATTERN,
  isReservedKeyringAccount,
} from '../keyring-account.js';

/** Classify a keyring error into a human-readable reason (never throws). */
export function classifyKeyringError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('cannot find module') || lower.includes('module not found') || lower.includes('failed to load')) {
    return 'native keyring module not available on this system';
  }
  if (lower.includes('secret service') || lower.includes('dbus') || lower.includes('daemon')) {
    return 'Secret Service daemon is not running (start GNOME Keyring or KWallet)';
  }
  if (lower.includes('denied') || lower.includes('locked') || lower.includes('cancelled') || lower.includes('user refused')) {
    return 'keychain access was denied or the keychain is locked';
  }
  return `keyring error: ${msg}`;
}

export const KEYRING_SERVICE = 'clodex';
export const KEYRING_CHUNK_SERVICE = 'clodex-chunks';
export const KEYRING_JOURNAL_SERVICE = 'clodex-journal';
export const KEYRING_DELETED_SERVICE = 'clodex-deleted';
export const KEYRING_MANAGED_STATE_KEY_SERVICE = 'clodex-state-key';
export const KEYRING_DELETED_VALUE = 'v1:deleted';
export const KEYRING_PENDING_DELETE_VALUE = 'v1:pending';
export const KEYRING_MANAGED_STATE_KEY_PREFIX = 'v1:';
// Windows Credential Manager caps a single credential blob at 2560 bytes (CredWriteW).
// keyring-rs encodes the password as UTF-16 (2 bytes/char) before that check, so the
// usable limit is 2560 / 2 = 1280 chars — long OAuth tokens (e.g. OpenAI's JWTs) exceed
// this, so secrets above the threshold are split across multiple keyring entries.
// Harmless on macOS/Linux, which have no such limit.
export const KEYRING_CHUNK_PREFIX = '__relay_chunked__:';
export const KEYRING_JOURNAL_PREFIX = '__clodex_chunk_journal__:v1:';
const KEYRING_DELETE_TOMBSTONE_PREFIX = '__clodex_delete__:';
const KEYRING_ENUMERATION_SENTINEL_PREFIX = '__clodex_inventory__:';
export const KEYRING_MAX_ENTRY_CHARS = 1200;
export const KEYRING_CHUNK_SIZE = 1200;
export const KEYRING_MAX_WRITE_GENERATIONS = 2;
export const KEYRING_MAX_DELETE_GENERATIONS = 6;

export interface KeyringChunkMarker {
  count: number;
  generation?: string;
  digest?: string;
}

export interface KeyringChunkJournal {
  mode: 'write' | 'short' | 'delete' | 'deleted';
  generations: KeyringChunkMarker[];
  shortDigest?: string;
  fallbackShortDigest?: string;
  unpublished?: true;
  publicationAttempted?: true;
  blockLegacy?: true;
  unverifiable?: true;
}

export type UntrustedKeyringChunkJournal = Omit<Partial<KeyringChunkJournal>,
  'unpublished' | 'publicationAttempted' | 'blockLegacy' | 'unverifiable'> & {
  unpublished?: unknown;
  publicationAttempted?: unknown;
  blockLegacy?: unknown;
  unverifiable?: unknown;
};

export type KeyringApi = Pick<typeof import('@napi-rs/keyring'), 'Entry' | 'findCredentials'>;

export function oauthProviderIdFromAccount(account: string): string | null {
  const prefix = 'oauth:provider:';
  const baseAccount = credentialAccountBase(account);
  if (!baseAccount.startsWith(prefix)) return null;
  const providerId = baseAccount.slice(prefix.length);
  // Managed account credentials use a unique suffix while retaining the
  // canonical OAuth provider id for token refresh behavior.
  if (providerId.startsWith('openai-oauth:account:')) return 'openai-oauth';
  if (providerId.startsWith('xai-oauth:account:')) return 'xai-oauth';
  return providerId;
}

export const oauthRefreshInflight = new Map<string, Promise<string | null>>();
export interface CachedOAuthCredential {
  access: string;
  expires: number;
  accessRejected?: true;
  checkedAt: number;
}

// Another process can replace the shared credential without invalidating this
// process. Keep only access-token metadata and bound that stale view to 30 seconds;
// rejection and expiration bypass it immediately.
export const OAUTH_CREDENTIAL_CACHE_MAX_AGE_MS = 30_000;
export const oauthCredentialCache = new Map<string, CachedOAuthCredential>();
const rejectedEnvCredentialFingerprints = new Map<string, string>();
export const OAUTH_REFRESH_LOCK_WAIT_MS = 150_000;
export const OAUTH_STATE_KEY_SEPARATOR = '\0';

export function readEnvCredential(varName: string): string | null {
  const raw = process.env[varName];
  if (!raw?.trim()) return null;
  return raw.trim().split(/\r?\n/)[0]?.trim() || null;
}

function credentialFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function usableEnvCredential(
  source: string,
  value: string | null,
  rejectedAccessToken?: string,
): string | null {
  if (!value) {
    rejectedEnvCredentialFingerprints.delete(source);
    return null;
  }

  const fingerprint = credentialFingerprint(value);
  if (
    rejectedAccessToken !== undefined
    && fingerprint === credentialFingerprint(rejectedAccessToken)
  ) {
    rejectedEnvCredentialFingerprints.set(source, fingerprint);
    return null;
  }

  const rejectedFingerprint = rejectedEnvCredentialFingerprints.get(source);
  if (rejectedFingerprint === fingerprint) return null;
  if (rejectedFingerprint !== undefined) {
    rejectedEnvCredentialFingerprints.delete(source);
  }
  return value;
}

export function readKeyringEntry(keyring: KeyringApi, service: string, account: string): string | null {
  const value = new keyring.Entry(service, account).getPassword();
  if (value !== null) return value;

  const matches = keyring
    .findCredentials(service)
    .filter(credential => credential.account === account);
  if (matches.length > 1) {
    throw new Error(`keyring credential account is ambiguous: ${account}`);
  }
  return matches[0]?.password ?? null;
}

export function deleteKeyringEntry(keyring: KeyringApi, service: string, account: string): boolean {
  const entry = new keyring.Entry(service, account);
  const existing = readKeyringEntry(keyring, service, account);
  if (existing === null) {
    entry.deletePassword();
    return readKeyringEntry(keyring, service, account) === null;
  }
  if (!persistKeyringDeletionTombstone(keyring, service, account, existing)) return false;
  if (!entry.deletePassword()) return false;
  return readKeyringEntry(keyring, service, account) === null;
}

export function hasUnjournaledKeyringChunks(keyring: KeyringApi, account: string): boolean {
  const prefix = `${account}::chunk::`;
  return [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE].some(service =>
    keyring
      .findCredentials(service)
      .some(
        credential =>
          credential.account.startsWith(prefix) && isReservedKeyringAccount(credential.account),
      ),
  );
}

export function listUnjournaledKeyringChunks(
  keyring: KeyringApi,
  account: string,
): Array<{ service: string; account: string; value: string }> {
  const prefix = `${account}::chunk::`;
  return [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE].flatMap(service =>
    keyring
      .findCredentials(service)
      .filter(
        credential =>
          credential.account.startsWith(prefix) && isReservedKeyringAccount(credential.account),
      )
      .map(credential => ({
        service,
        account: credential.account,
        value: credential.password,
      })),
  );
}

export interface KeyringEnumerationSentinel {
  service: string;
  account: string;
  value: string;
}

export function createKeyringEnumerationSentinel(
  service: string,
  account: string,
): KeyringEnumerationSentinel {
  const generation = randomUUID();
  return {
    service,
    account: `${account}::chunk::${generation}::0`,
    value: `${KEYRING_ENUMERATION_SENTINEL_PREFIX}${generation}`,
  };
}

export function writeKeyringEnumerationSentinel(
  keyring: KeyringApi,
  sentinel: KeyringEnumerationSentinel,
): void {
  new keyring.Entry(sentinel.service, sentinel.account).setPassword(sentinel.value);
  if (readKeyringEntry(keyring, sentinel.service, sentinel.account) !== sentinel.value) {
    throw new Error('keyring credential inventory sentinel could not be verified');
  }
}

export function sameKeyringEnumerationEntry(
  entry: { service: string; account: string },
  sentinel: KeyringEnumerationSentinel,
): boolean {
  return entry.service === sentinel.service && entry.account === sentinel.account;
}

export function removeKeyringEnumerationSentinel(
  keyring: KeyringApi,
  sentinel: KeyringEnumerationSentinel,
): boolean {
  const current = readKeyringEntry(keyring, sentinel.service, sentinel.account);
  if (current === null) return true;
  if (current !== sentinel.value) return false;
  if (!new keyring.Entry(sentinel.service, sentinel.account).deletePassword()) {
    return false;
  }
  return readKeyringEntry(keyring, sentinel.service, sentinel.account) === null;
}

function isKeyringInventoryBookkeepingEntry(
  entry: { account: string; value: string },
  ownerAccount: string,
): boolean {
  const accountPrefix = `${ownerAccount}::chunk::`;
  const accountSuffix = '::0';
  if (!entry.account.startsWith(accountPrefix) || !entry.account.endsWith(accountSuffix)) {
    return false;
  }
  const generation = entry.account.slice(accountPrefix.length, -accountSuffix.length);
  return (
    KEYRING_GENERATION_PATTERN.test(generation) &&
    entry.value === `${KEYRING_ENUMERATION_SENTINEL_PREFIX}${generation}`
  );
}

function removeKeyringBookkeepingEntry(
  keyring: KeyringApi,
  ownerAccount: string,
  entry: { service: string; account: string; value: string },
): boolean {
  if (!isKeyringInventoryBookkeepingEntry(entry, ownerAccount)) return false;
  if (readKeyringEntry(keyring, entry.service, entry.account) !== entry.value) return false;
  if (!new keyring.Entry(entry.service, entry.account).deletePassword()) {
    return false;
  }
  return readKeyringEntry(keyring, entry.service, entry.account) === null;
}

export function verifyEmptyKeyringCredentialInventory(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  const sentinels: KeyringEnumerationSentinel[] = [];
  let empty = false;
  let cleanupComplete = true;
  try {
    for (const service of [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE]) {
      const sentinel = createKeyringEnumerationSentinel(service, account);
      sentinels.push(sentinel);
      writeKeyringEnumerationSentinel(keyring, sentinel);
    }
    const currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    const inventory = listUnjournaledKeyringChunks(keyring, account);
    const complete = sentinels.every(sentinel =>
      inventory.some(entry => sameKeyringEnumerationEntry(entry, sentinel)),
    );
    const credentialEntries = inventory.filter(
      entry =>
        !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)) &&
        !isKeyringInventoryBookkeepingEntry(entry, account),
    );
    const bookkeepingEntries = inventory.filter(
      entry =>
        !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)) &&
        isKeyringInventoryBookkeepingEntry(entry, account),
    );
    for (const entry of bookkeepingEntries) {
      if (!removeKeyringBookkeepingEntry(keyring, account, entry)) {
        cleanupComplete = false;
        diag?.('keyring credential inventory bookkeeping could not be removed');
      }
    }
    empty = complete && currentValue === null && credentialEntries.length === 0;
    if (!complete) {
      diag?.('keyring credential inventory could not be verified');
    } else if (!empty) {
      diag?.('keyring credential inventory is not empty');
    }
  } catch (err) {
    diag?.(classifyKeyringError(err));
  } finally {
    for (const sentinel of sentinels) {
      try {
        if (!removeKeyringEnumerationSentinel(keyring, sentinel)) {
          cleanupComplete = false;
          diag?.('keyring credential inventory sentinel could not be removed');
        }
      } catch (err) {
        cleanupComplete = false;
        diag?.(classifyKeyringError(err));
      }
    }
  }
  return empty && cleanupComplete;
}

export function isDisposableCredentialProbeAccount(account: string): boolean {
  const separator = '::probe::';
  const separatorIndex = account.lastIndexOf(separator);
  return (
    separatorIndex > 0 &&
    KEYRING_GENERATION_PATTERN.test(account.slice(separatorIndex + separator.length))
  );
}

function persistKeyringDeletionTombstone(
  keyring: KeyringApi,
  service: string,
  account: string,
  existing: string,
): boolean {
  if (existing.startsWith(KEYRING_DELETE_TOMBSTONE_PREFIX)) return true;
  const tombstone = `${KEYRING_DELETE_TOMBSTONE_PREFIX}${randomUUID()}`;
  new keyring.Entry(service, account).setPassword(tombstone);
  return readKeyringEntry(keyring, service, account) === tombstone;
}
