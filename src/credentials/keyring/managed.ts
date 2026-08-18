import { createHash, randomUUID } from 'node:crypto';
import { isCredentialAccountInstance } from '../helper.js';
import {
  getCredentialMutationLockPath,
  withRegistryWriteLock,
} from '../../registry/lock.js';
import { KEYRING_MAX_CHUNKS } from '../keyring-account.js';
import {
  classifyKeyringError,
  KEYRING_SERVICE,
  KEYRING_CHUNK_SERVICE,
  KEYRING_JOURNAL_SERVICE,
  KEYRING_CHUNK_SIZE,
  readKeyringEntry,
  deleteKeyringEntry,
  hasUnjournaledKeyringChunks,
  listUnjournaledKeyringChunks,
  createKeyringEnumerationSentinel,
  writeKeyringEnumerationSentinel,
  sameKeyringEnumerationEntry,
  removeKeyringEnumerationSentinel,
  verifyEmptyKeyringCredentialInventory,
  isDisposableCredentialProbeAccount,
} from './base.js';
import type {
  KeyringChunkMarker,
  KeyringChunkJournal,
  KeyringApi,
  KeyringEnumerationSentinel,
} from './base.js';
import {
  readKeyringAccountFromService,
  readKeyringMarkerChunks,
  parseKeyringChunkMarker,
  encodeKeyringChunkMarker,
  parseKeyringChunkJournal,
  sameKeyringMarker,
  appendUniqueKeyringMarker,
  encodeKeyringJournal,
  keyringDeleteJournalFits,
  keyringChunkAccount,
  splitKeyringCredential,
  writeKeyringJournal,
  adoptKeyringJournal,
  readKeyringDeletionGuard,
  writeKeyringDeletionGuard,
  clearKeyringDeletionGuard,
} from './codec.js';
import { reconcileKeyringJournal } from './journal.js';
import { KeyringManagedStateKeyUnavailableError, readKeyringManagedState, removeKeyringManagedState } from './state.js';
import type { KeyringManagedState } from './state.js';

function keyringAccountLockPath(account: string): string {
  return getCredentialMutationLockPath(`keyring:${account}`);
}

async function withKeyringAccountLock<T>(
  account: string,
  fallback: T,
  diag: ((msg: string) => void) | undefined,
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    return await withRegistryWriteLock(operation, {
      lockPath: keyringAccountLockPath(account),
    });
  } catch {
    diag?.('keyring credential store is busy or unavailable');
    return fallback;
  }
}

export async function readKeyringAccount(
  account: string,
  diag?: (msg: string) => void,
): Promise<string | null> {
  return withKeyringAccountLock(account, null, diag, async () => {
    try {
      const keyring = await import('@napi-rs/keyring');
      const cleanupComplete = reconcileKeyringJournal(keyring, account, diag);
      const finalJournalRaw = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
      const finalJournal =
        finalJournalRaw === null ? null : parseKeyringChunkJournal(finalJournalRaw);
      if (finalJournal?.mode === 'delete' || finalJournal?.mode === 'deleted') return null;
      if (
        finalJournalRaw === null &&
        readKeyringManagedState(keyring, account)?.mode === 'managed'
      ) {
        return null;
      }
      if (finalJournal?.mode === 'short') {
        const value = readKeyringEntry(keyring, KEYRING_SERVICE, account);
        if (
          value === null ||
          createHash('sha256').update(value).digest('hex') !== finalJournal.shortDigest
        )
          return null;
        return value;
      }
      if (finalJournal?.mode === 'write') {
        return readKeyringAccountFromService(keyring, KEYRING_SERVICE, account);
      }
      if (!cleanupComplete) return null;

      const rawValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
      if (rawValue === null) return null;
      const marker = parseKeyringChunkMarker(rawValue);
      if (marker) {
        const value = readKeyringAccountFromService(keyring, KEYRING_SERVICE, account);
        adoptKeyringJournal(
          keyring,
          account,
          {
            mode: 'write',
            generations: [marker],
          },
          diag,
        );
        return value;
      }
      adoptKeyringJournal(
        keyring,
        account,
        {
          mode: 'short',
          generations: [],
          shortDigest: createHash('sha256').update(rawValue).digest('hex'),
        },
        diag,
      );
      return rawValue;
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return null;
    }
  });
}

function persistUnverifiableKeyringDeletion(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
  blockLegacy = false,
): boolean {
  try {
    const journal: KeyringChunkJournal = {
      mode: 'delete',
      generations: [],
      unverifiable: true,
    };
    if (blockLegacy) journal.blockLegacy = true;
    writeKeyringJournal(keyring, account, journal);
    diag?.('unverifiable credential state was marked for verified deletion');
    return true;
  } catch {
    diag?.('unverifiable credential state could not be marked for deletion');
    return false;
  }
}

function recoverEmptyPublishedKeyringState(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  const rawJournal = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
  if (rawJournal === null) return false;
  const journal = parseKeyringChunkJournal(rawJournal);
  if (
    (journal.mode !== 'write' && journal.mode !== 'short') ||
    journal.unpublished === true ||
    readKeyringEntry(keyring, KEYRING_SERVICE, account) !== null
  ) {
    return false;
  }
  if (!verifyEmptyKeyringCredentialInventory(keyring, account, diag)) {
    return false;
  }
  if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
    diag?.('keyring deletion guard could not be verified');
    return false;
  }
  writeKeyringJournal(keyring, account, {
    mode: 'deleted',
    generations: [],
  });
  diag?.('discarded missing published credential metadata after verifying an empty keyring');
  return true;
}

function recoverEmptyOpaqueManagedKeyringState(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== null) {
    return false;
  }
  if (!verifyEmptyKeyringCredentialInventory(keyring, account, diag)) {
    return false;
  }
  if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
    diag?.('keyring deletion guard could not be verified');
    return false;
  }
  removeKeyringManagedState(account);
  writeKeyringJournal(keyring, account, {
    mode: 'deleted',
    generations: [],
  });
  diag?.('recovered managed credential metadata after verifying an empty keyring');
  return true;
}

function retireUnreadableManagedStateForDeletion(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  try {
    readKeyringManagedState(keyring, account);
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    if (!(err instanceof KeyringManagedStateKeyUnavailableError)) {
      return false;
    }
  }
  try {
    removeKeyringManagedState(account);
    diag?.('retired unreadable managed credential metadata for explicit deletion');
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}

function writeKeyringAccountLocked(
  keyring: KeyringApi,
  account: string,
  key: string,
  intent: 'probe' | 'provision' | 'replace',
  diag?: (msg: string) => void,
): boolean {
  try {
    let reconciled: boolean;
    let deletedMarkerActive = false;
    try {
      const deletionGuard = readKeyringDeletionGuard(keyring, account);
      const rawJournal = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
      const initialJournal = rawJournal === null ? null : parseKeyringChunkJournal(rawJournal);
      deletedMarkerActive = deletionGuard !== null || initialJournal?.mode === 'deleted';
      if (
        initialJournal?.mode === 'short' &&
        initialJournal.unpublished === true &&
        initialJournal.publicationAttempted === true
      ) {
        if (deletedMarkerActive) {
          if (!clearKeyringDeletionGuard(keyring, account)) {
            throw new Error('keyring deletion guard could not be cleared');
          }
          deletedMarkerActive = false;
        }
        const shortDigest = createHash('sha256').update(key).digest('hex');
        if (shortDigest !== initialJournal.shortDigest) {
          writeKeyringJournal(keyring, account, {
            ...initialJournal,
            shortDigest,
          });
        }
        const accountEntry = new keyring.Entry(KEYRING_SERVICE, account);
        accountEntry.setPassword(key);
        if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== key) {
          throw new Error('keyring credential write verification failed');
        }
        if (!reconcileKeyringJournal(keyring, account, diag)) return false;
        return true;
      }
      reconciled = reconcileKeyringJournal(keyring, account, diag);
      if (
        !reconciled &&
        intent !== 'probe' &&
        recoverEmptyPublishedKeyringState(keyring, account, diag)
      ) {
        reconciled = reconcileKeyringJournal(keyring, account, diag);
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      if (
        err instanceof KeyringManagedStateKeyUnavailableError &&
        intent !== 'probe' &&
        recoverEmptyOpaqueManagedKeyringState(keyring, account, diag)
      ) {
        reconciled = reconcileKeyringJournal(keyring, account, diag);
      } else {
        return false;
      }
    }
    if (!reconciled) return false;

    const activeJournalRaw = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
    const activeJournal =
      activeJournalRaw === null ? null : parseKeyringChunkJournal(activeJournalRaw);
    const managedState = readKeyringManagedState(keyring, account);
    deletedMarkerActive =
      deletedMarkerActive ||
      activeJournal?.mode === 'deleted' ||
      readKeyringDeletionGuard(keyring, account) !== null;

    const accountEntry = new keyring.Entry(KEYRING_SERVICE, account);
    const previousValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    if (intent === 'probe') {
      if (
        !isDisposableCredentialProbeAccount(account) ||
        activeJournal !== null ||
        managedState !== null ||
        deletedMarkerActive ||
        previousValue !== null ||
        hasUnjournaledKeyringChunks(keyring, account)
      ) {
        diag?.('credential account is not available for a new credential');
        return false;
      }
    } else if (intent === 'provision') {
      if (!isCredentialAccountInstance(account)) {
        diag?.('provisioned credentials require a versioned account instance');
        return false;
      }
    } else if (activeJournal === null && managedState === null && previousValue === null) {
      diag?.('existing credential state could not be confirmed');
      return false;
    }
    if (deletedMarkerActive) {
      if (!clearKeyringDeletionGuard(keyring, account)) {
        throw new Error('keyring deletion guard could not be cleared');
      }
      deletedMarkerActive = false;
    }
    let previousMarker =
      activeJournal?.mode === 'write' ? (activeJournal.generations[0] ?? null) : null;
    let previousShortDigest =
      activeJournal?.mode === 'short' ? activeJournal.shortDigest : undefined;
    try {
      if (activeJournal?.mode === 'short') {
        if (
          previousValue !== null &&
          createHash('sha256').update(previousValue).digest('hex') !== previousShortDigest
        ) {
          throw new Error('published short credential changed after reconciliation');
        }
      } else if (activeJournal?.mode === 'write') {
        if (previousValue !== null) {
          const observedMarker = parseKeyringChunkMarker(previousValue);
          if (
            !observedMarker ||
            !previousMarker ||
            !sameKeyringMarker(observedMarker, previousMarker)
          ) {
            throw new Error('published chunk credential changed after reconciliation');
          }
        }
      } else if (activeJournal === null) {
        previousMarker = parseKeyringChunkMarker(previousValue);
        if (previousMarker) {
          try {
            readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, previousMarker);
          } catch {
            previousMarker = null;
          }
        }
        if (previousValue !== null && !previousMarker) {
          previousShortDigest = createHash('sha256').update(previousValue).digest('hex');
        }
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      persistUnverifiableKeyringDeletion(keyring, account, diag);
      return false;
    }
    const unpublished =
      activeJournal?.mode !== 'write' && activeJournal?.mode !== 'short' && previousValue === null;
    if (key.length <= KEYRING_CHUNK_SIZE) {
      const shortDigest = createHash('sha256').update(key).digest('hex');
      const transitionJournal: KeyringChunkJournal = {
        mode: 'short',
        generations: previousMarker ? [previousMarker] : [],
        shortDigest,
      };
      if (previousShortDigest) transitionJournal.fallbackShortDigest = previousShortDigest;
      if (unpublished) transitionJournal.unpublished = true;
      writeKeyringJournal(keyring, account, transitionJournal);
      accountEntry.setPassword(key);
      if (unpublished) {
        writeKeyringJournal(keyring, account, {
          ...transitionJournal,
          publicationAttempted: true,
        });
      }
      if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== key) {
        throw new Error('keyring credential write verification failed');
      }
      if (!reconcileKeyringJournal(keyring, account, diag)) {
        diag?.('keyring cleanup is pending and will be retried');
      }
      return true;
    }
    const chunks = splitKeyringCredential(key);
    const chunkCount = chunks.length;
    if (chunkCount > KEYRING_MAX_CHUNKS) {
      throw new Error('keyring credential exceeds the supported chunk count');
    }
    const marker: KeyringChunkMarker = {
      count: chunkCount,
      generation: randomUUID(),
      digest: createHash('sha256').update(key).digest('hex'),
    };
    const transitionJournal: KeyringChunkJournal = {
      mode: 'write',
      generations: [marker, ...(previousMarker ? [previousMarker] : [])],
    };
    if (previousShortDigest) transitionJournal.fallbackShortDigest = previousShortDigest;
    if (unpublished) transitionJournal.unpublished = true;
    writeKeyringJournal(keyring, account, transitionJournal);
    for (const [i, chunk] of chunks.entries()) {
      new keyring.Entry(KEYRING_CHUNK_SERVICE, keyringChunkAccount(account, marker, i)).setPassword(
        chunk,
      );
    }
    const encodedMarker = encodeKeyringChunkMarker(marker);
    accountEntry.setPassword(encodedMarker);
    if (unpublished) {
      writeKeyringJournal(keyring, account, {
        ...transitionJournal,
        publicationAttempted: true,
      });
    }
    if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== encodedMarker) {
      throw new Error('keyring credential write verification failed');
    }
    if (!reconcileKeyringJournal(keyring, account, diag)) {
      diag?.('keyring cleanup is pending and will be retried');
    }
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}

export async function writeKeyringAccount(
  account: string,
  key: string,
  intent: 'probe' | 'provision' | 'replace',
  diag?: (msg: string) => void,
): Promise<boolean> {
  return withKeyringAccountLock(account, false, diag, async () => {
    try {
      const keyring = await import('@napi-rs/keyring');
      return writeKeyringAccountLocked(keyring, account, key, intent, diag);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  });
}

function deleteJournalLessManagedKeyringAccount(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
  retireUnreadableManagedState = false,
): boolean {
  const sentinels: KeyringEnumerationSentinel[] = [];
  let sentinelsRemoved = false;
  try {
    for (const service of [KEYRING_SERVICE, KEYRING_CHUNK_SERVICE]) {
      const sentinel = createKeyringEnumerationSentinel(service, account);
      sentinels.push(sentinel);
      writeKeyringEnumerationSentinel(keyring, sentinel);
    }
    const currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    parseKeyringChunkMarker(currentValue);
    // The keyring binding returns a complete service snapshot or an error. Sentinels detect
    // backends that make this account namespace temporarily invisible without throwing.
    const inventory = listUnjournaledKeyringChunks(keyring, account);
    if (
      sentinels.some(
        sentinel => !inventory.some(entry => sameKeyringEnumerationEntry(entry, sentinel)),
      )
    ) {
      diag?.('keyring credential chunk inventory could not be verified');
      return false;
    }
    const chunks = inventory.filter(
      entry => !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)),
    );
    if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
      diag?.('keyring deletion guard could not be verified');
      return false;
    }
    if (!deleteKeyringEntry(keyring, KEYRING_SERVICE, account)) {
      diag?.('keyring credential deletion could not be verified');
      return false;
    }
    for (const chunk of chunks) {
      if (!deleteKeyringEntry(keyring, chunk.service, chunk.account)) {
        diag?.('keyring credential chunk deletion could not be verified');
        return false;
      }
    }
    const remainingInventory = listUnjournaledKeyringChunks(keyring, account);
    if (
      sentinels.some(
        sentinel =>
          !remainingInventory.some(entry => sameKeyringEnumerationEntry(entry, sentinel)),
      ) ||
      remainingInventory.some(
        entry => !sentinels.some(sentinel => sameKeyringEnumerationEntry(entry, sentinel)),
      )
    ) {
      diag?.('keyring credential chunk deletion could not be verified');
      return false;
    }
    for (const sentinel of sentinels) {
      if (!removeKeyringEnumerationSentinel(keyring, sentinel)) {
        diag?.('keyring credential inventory sentinel could not be removed');
        return false;
      }
    }
    sentinelsRemoved = true;
    if (retireUnreadableManagedState) {
      removeKeyringManagedState(account);
      diag?.('retired unreadable managed credential metadata for explicit deletion');
    }
    writeKeyringJournal(keyring, account, {
      mode: 'deleted',
      generations: [],
    });
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  } finally {
    if (!sentinelsRemoved) {
      for (const sentinel of sentinels) {
        try {
          if (!removeKeyringEnumerationSentinel(keyring, sentinel)) {
            diag?.('keyring credential inventory sentinel could not be removed');
          }
        } catch (err) {
          diag?.(classifyKeyringError(err));
        }
      }
    }
  }
}

export async function deleteKeyringAccount(
  account: string,
  diag?: (msg: string) => void,
  blockLegacy = true,
): Promise<boolean> {
  return withKeyringAccountLock(account, false, diag, async () => {
    try {
      const keyring = await import('@napi-rs/keyring');
      let pendingJournalRaw = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
      if (pendingJournalRaw === null) {
        let managedState: KeyringManagedState | null;
        try {
          managedState = readKeyringManagedState(keyring, account);
        } catch (err) {
          diag?.(classifyKeyringError(err));
          if (err instanceof KeyringManagedStateKeyUnavailableError) {
            if (recoverEmptyOpaqueManagedKeyringState(keyring, account, diag)) {
              return true;
            }
            return deleteJournalLessManagedKeyringAccount(keyring, account, diag, true);
          }
          return false;
        }
        if (managedState !== null) {
          if (managedState.journal === null) {
            return deleteJournalLessManagedKeyringAccount(keyring, account, diag);
          }
          writeKeyringJournal(keyring, account, managedState.journal);
          pendingJournalRaw = encodeKeyringJournal(managedState.journal);
          diag?.('restored keyring cleanup journal from managed state');

        } else if (readKeyringDeletionGuard(keyring, account) !== null) {
          return reconcileKeyringJournal(keyring, account, diag);
        }
      }
      let pendingJournal: KeyringChunkJournal | null = null;
      try {
        if (pendingJournalRaw !== null) {
          pendingJournal = parseKeyringChunkJournal(pendingJournalRaw);
          if (!retireUnreadableManagedStateForDeletion(keyring, account, diag)) {
            return false;
          }
          if (pendingJournal.mode === 'deleted') {
            return reconcileKeyringJournal(keyring, account, diag);
          }
          if (pendingJournal.mode === 'delete') {
            if (blockLegacy && pendingJournal.blockLegacy !== true) {
              pendingJournal = {
                ...pendingJournal,
                blockLegacy: true,
              };
              writeKeyringJournal(keyring, account, pendingJournal);
            }
            return reconcileKeyringJournal(keyring, account, diag);
          }
        }
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
      const value = readKeyringEntry(keyring, KEYRING_SERVICE, account);
      if (pendingJournal === null && value === null) {
        throw new Error('existing credential state could not be confirmed');
      }
      const generations: KeyringChunkMarker[] = [];
      for (const marker of pendingJournal?.generations ?? []) {
        appendUniqueKeyringMarker(generations, marker);
      }
      let unverifiable = false;
      const shortDigest = pendingJournal?.mode === 'short' ? pendingJournal.shortDigest : undefined;
      if (pendingJournal?.mode !== 'short') {
        try {
          const marker = parseKeyringChunkMarker(value);
          if (marker) appendUniqueKeyringMarker(generations, marker);
        } catch (err) {
          unverifiable = true;
          diag?.(classifyKeyringError(err));
        }
      }
      if (!keyringDeleteJournalFits(generations, unverifiable, blockLegacy, shortDigest)) {
        diag?.('keyring cleanup has too many pending generations');
        return false;
      }
      const deleteJournal: KeyringChunkJournal = {
        mode: 'delete',
        generations,
      };
      if (shortDigest) deleteJournal.shortDigest = shortDigest;
      if (blockLegacy) deleteJournal.blockLegacy = true;
      if (unverifiable) deleteJournal.unverifiable = true;
      writeKeyringJournal(keyring, account, deleteJournal);
      return reconcileKeyringJournal(keyring, account, diag);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  });
}
