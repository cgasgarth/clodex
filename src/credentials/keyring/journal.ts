import { createHash } from 'node:crypto';
import {
  classifyKeyringError,
  KEYRING_SERVICE,
  KEYRING_JOURNAL_SERVICE,
  KEYRING_MANAGED_STATE_KEY_SERVICE,
  readKeyringEntry,
  deleteKeyringEntry,
  verifyEmptyKeyringCredentialInventory,
} from './base.js';
import type { KeyringChunkMarker, KeyringChunkJournal, KeyringApi } from './base.js';
import {
  readKeyringMarkerChunks,
  parseKeyringChunkMarker,
  encodeKeyringChunkMarker,
  parseKeyringChunkJournal,
  sameKeyringGeneration,
  sameKeyringMarker,
  appendUniqueKeyringMarker,
  encodeKeyringJournal,
  keyringDeleteJournalFits,
  removeKeyringChunkRange,
  removeKeyringChunks,
  writeKeyringJournal,
  readKeyringDeletionGuard,
  writeKeyringDeletionGuard,
  clearKeyringDeletionGuard,
} from './codec.js';
import { readKeyringManagedState, persistKeyringManagedState, removeKeyringManagedState } from './state.js';

export function reconcileKeyringJournal(
  keyring: KeyringApi,
  account: string,
  diag?: (msg: string) => void,
): boolean {
  let rawJournal = readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account);
  let managedState = readKeyringManagedState(keyring, account);
  if (managedState?.mode === 'preparing') {
    try {
      writeKeyringJournal(keyring, account, managedState.journal);
      rawJournal = encodeKeyringJournal(managedState.journal);
      managedState = { mode: 'managed', journal: managedState.journal };
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  } else if (rawJournal === null && managedState?.mode === 'managed') {
    if (managedState.journal === null) {
      diag?.('managed keyring state has no recoverable cleanup journal');
      return false;
    }
    try {
      writeKeyringJournal(keyring, account, managedState.journal);
      rawJournal = encodeKeyringJournal(managedState.journal);
      diag?.('restored keyring cleanup journal from managed state');
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }
  const deletionGuard = readKeyringDeletionGuard(keyring, account);
  if (rawJournal === null) {
    if (deletionGuard === null) {
      return true;
    }
    const restoredJournal: KeyringChunkJournal =
      deletionGuard === 'deleted'
        ? {
            mode: 'deleted',
            generations: [],
          }
        : {
            mode: 'delete',
            generations: [],
          };
    writeKeyringJournal(keyring, account, restoredJournal);
    rawJournal = encodeKeyringJournal(restoredJournal);
  }
  let journal = parseKeyringChunkJournal(rawJournal);
  if (
    managedState?.mode !== 'managed' ||
    managedState.journal === null ||
    encodeKeyringJournal(managedState.journal) !== rawJournal
  ) {
    try {
      persistKeyringManagedState(keyring, account, { mode: 'managed', journal });
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }
  const accountEntry = new keyring.Entry(KEYRING_SERVICE, account);

  if (journal.mode === 'deleted') {
    let currentValue: string | null;
    let currentMarker: KeyringChunkMarker | null = null;
    let unverifiable = false;
    try {
      currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
      currentMarker = parseKeyringChunkMarker(currentValue);
    } catch (err) {
      unverifiable = true;
      diag?.(classifyKeyringError(err));
    }
    const resumedJournal: KeyringChunkJournal = {
      mode: 'delete',
      generations: currentMarker ? [currentMarker] : [],
      blockLegacy: true,
    };
    if (unverifiable) resumedJournal.unverifiable = true;
    try {
      writeKeyringJournal(keyring, account, resumedJournal);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    journal = resumedJournal;
  }

  let activeMarker: KeyringChunkMarker | null = null;
  let activeShortCredentialDigest: string | null = null;
  if (journal.mode === 'delete') {
    let currentMarker: KeyringChunkMarker | null = null;
    let activeShortDigest = journal.shortDigest;
    let unverifiable = journal.unverifiable === true;
    let currentValue: string | null;
    try {
      currentValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    if (
      currentValue === null ||
      !activeShortDigest ||
      createHash('sha256').update(currentValue).digest('hex') !== activeShortDigest
    ) {
      activeShortDigest = undefined;
      try {
        currentMarker = parseKeyringChunkMarker(currentValue);
      } catch (err) {
        unverifiable = true;
        diag?.(classifyKeyringError(err));
      }
    }

    let preparedGenerations = journal.generations.map(marker => ({
      ...marker,
    }));
    if (currentMarker) appendUniqueKeyringMarker(preparedGenerations, currentMarker);
    if (
      !keyringDeleteJournalFits(
        preparedGenerations,
        unverifiable,
        journal.blockLegacy === true,
        activeShortDigest,
      )
    ) {
      const protectedMarker = currentMarker
        ? (preparedGenerations.find(marker => sameKeyringGeneration(currentMarker, marker)) ??
          currentMarker)
        : null;
      let compacted = true;
      for (const marker of journal.generations) {
        if (protectedMarker && sameKeyringGeneration(protectedMarker, marker)) {
          continue;
        }
        if (!removeKeyringChunks(keyring, KEYRING_SERVICE, account, marker, diag)) {
          compacted = false;
        }
      }
      if (!compacted) return false;
      preparedGenerations = protectedMarker ? [protectedMarker] : [];
    }
    if (
      !keyringDeleteJournalFits(
        preparedGenerations,
        unverifiable,
        journal.blockLegacy === true,
        activeShortDigest,
      )
    ) {
      diag?.('keyring cleanup journal cannot represent the pending generations');
      return false;
    }
    const preparedJournal: KeyringChunkJournal = {
      mode: 'delete',
      generations: preparedGenerations,
    };
    if (activeShortDigest) preparedJournal.shortDigest = activeShortDigest;
    if (journal.blockLegacy) preparedJournal.blockLegacy = true;
    if (unverifiable) preparedJournal.unverifiable = true;
    if (encodeKeyringJournal(preparedJournal) !== rawJournal) {
      try {
        writeKeyringJournal(keyring, account, preparedJournal);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
    }
    journal = preparedJournal;
    try {
      if (
        !writeKeyringDeletionGuard(
          keyring,
          account,
          journal.blockLegacy === true ? 'deleted' : 'pending',
        )
      ) {
        diag?.('keyring deletion guard could not be verified');
        return false;
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    try {
      if (!deleteKeyringEntry(keyring, KEYRING_SERVICE, account)) {
        diag?.('keyring credential deletion could not be verified');
        return false;
      }
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  } else if (journal.mode === 'write') {
    let activeValue: string | null;
    try {
      activeValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    if (activeValue === null) {
      if (journal.unpublished !== true) {
        diag?.('published credential state cannot be confirmed while cleanup metadata is active');
        return false;
      }
      if (journal.publicationAttempted === true) {
        const candidate = journal.generations[0];
        if (!candidate) return false;
        try {
          readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, candidate);
          const encodedCandidate = encodeKeyringChunkMarker(candidate);
          accountEntry.setPassword(encodedCandidate);
          if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== encodedCandidate) {
            throw new Error('keyring credential recovery verification failed');
          }
          activeMarker = candidate;
        } catch (err) {
          diag?.(classifyKeyringError(err));
          return false;
        }
      }
    } else if (
      journal.fallbackShortDigest &&
      createHash('sha256').update(activeValue).digest('hex') === journal.fallbackShortDigest
    ) {
      activeShortCredentialDigest = journal.fallbackShortDigest;
    } else {
      try {
        activeMarker = parseKeyringChunkMarker(activeValue);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
      if (!activeMarker) {
        diag?.('published credential kind is not represented by cleanup journal');
        return false;
      }
    }

    const activeJournalMarker = activeMarker
      ? journal.generations.find(marker => sameKeyringGeneration(activeMarker, marker))
      : undefined;
    if (activeMarker && !activeJournalMarker) {
      throw new Error('published credential generation is not represented by cleanup journal');
    }
    if (activeMarker && activeJournalMarker) {
      try {
        readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, activeMarker);
        if (
          activeJournalMarker.count > activeMarker.count &&
          !removeKeyringChunkRange(
            keyring,
            KEYRING_SERVICE,
            account,
            activeJournalMarker,
            activeMarker.count,
            diag,
          )
        ) {
          return false;
        }
      } catch (err) {
        diag?.(classifyKeyringError(err));
        const recoveryCandidates = [
          ...(!sameKeyringMarker(activeMarker, activeJournalMarker) ? [activeJournalMarker] : []),
          ...journal.generations.filter(marker => !sameKeyringGeneration(activeMarker, marker)),
        ];
        let recovered = false;
        for (const candidate of recoveryCandidates) {
          try {
            readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, candidate);
            if (
              activeMarker.count > activeJournalMarker.count &&
              !removeKeyringChunkRange(
                keyring,
                KEYRING_SERVICE,
                account,
                activeMarker,
                activeJournalMarker.count,
                diag,
              )
            ) {
              return false;
            }
            const encodedCandidate = encodeKeyringChunkMarker(candidate);
            accountEntry.setPassword(encodedCandidate);
            if (readKeyringEntry(keyring, KEYRING_SERVICE, account) !== encodedCandidate) {
              throw new Error('keyring credential recovery verification failed', { cause: err });
            }
            activeMarker = candidate;
            recovered = true;
            break;
          } catch (candidateErr) {
            diag?.(classifyKeyringError(candidateErr));
          }
        }
        if (!recovered) return false;
      }
    }
  } else {
    let activeValue: string | null;
    try {
      activeValue = readKeyringEntry(keyring, KEYRING_SERVICE, account);
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
    if (activeValue === null) {
      if (journal.unpublished !== true) {
        diag?.('published credential state cannot be confirmed while cleanup metadata is active');
        return false;
      }
      if (journal.publicationAttempted === true) return false;
    } else {
      const observedDigest = createHash('sha256').update(activeValue).digest('hex');
      if (observedDigest === journal.shortDigest) {
        activeShortCredentialDigest = observedDigest;
      } else if (observedDigest === journal.fallbackShortDigest) {
        activeShortCredentialDigest = observedDigest;
      } else {
        try {
          activeMarker = parseKeyringChunkMarker(activeValue);
        } catch (err) {
          diag?.(classifyKeyringError(err));
          return false;
        }
        if (
          !activeMarker ||
          !journal.generations.some(marker => sameKeyringGeneration(activeMarker, marker))
        ) {
          diag?.('published credential kind is not represented by cleanup journal');
          return false;
        }
        try {
          readKeyringMarkerChunks(keyring, KEYRING_SERVICE, account, activeMarker);
        } catch (err) {
          diag?.(classifyKeyringError(err));
          return false;
        }
      }
    }
  }

  let cleaned = true;
  for (const marker of journal.generations) {
    if (
      (journal.mode === 'write' || journal.mode === 'short') &&
      sameKeyringGeneration(activeMarker, marker)
    )
      continue;
    if (!removeKeyringChunks(keyring, KEYRING_SERVICE, account, marker, diag)) {
      cleaned = false;
    }
  }
  if (!cleaned) return false;
  if (journal.unverifiable === true) {
    if (!verifyEmptyKeyringCredentialInventory(keyring, account, diag)) {
      return false;
    }
    const verifiedDelete: KeyringChunkJournal = {
      mode: 'delete',
      generations: [],
    };
    if (journal.blockLegacy) verifiedDelete.blockLegacy = true;
    try {
      writeKeyringJournal(keyring, account, verifiedDelete);
      journal = verifiedDelete;
      diag?.('retired unverifiable credential metadata after verifying an empty keyring');
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }

  if (journal.mode === 'delete' && journal.blockLegacy === true) {
    try {
      writeKeyringJournal(keyring, account, {
        mode: 'deleted',
        generations: [],
      });
      return true;
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }

  if (journal.mode === 'delete') {
    try {
      if (!deleteKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account)) {
        diag?.('keyring cleanup journal could not be removed');
        return false;
      }
      if (!clearKeyringDeletionGuard(keyring, account)) {
        diag?.('keyring deletion guard could not be removed');
        return false;
      }
      removeKeyringManagedState(account);
      if (!deleteKeyringEntry(keyring, KEYRING_MANAGED_STATE_KEY_SERVICE, account)) {
        diag?.('keyring managed-state encryption key could not be removed');
        return false;
      }
      return true;
    } catch (err) {
      diag?.(classifyKeyringError(err));
      return false;
    }
  }

  if (activeShortCredentialDigest) {
    const activeInventory: KeyringChunkJournal = {
      mode: 'short',
      generations: [],
      shortDigest: activeShortCredentialDigest,
    };
    if (encodeKeyringJournal(activeInventory) !== rawJournal) {
      try {
        writeKeyringJournal(keyring, account, activeInventory);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
    }
    return true;
  }

  if (activeMarker) {
    const activeInventory: KeyringChunkJournal = {
      mode: 'write',
      generations: [{ ...activeMarker }],
    };
    if (encodeKeyringJournal(activeInventory) !== rawJournal) {
      try {
        writeKeyringJournal(keyring, account, activeInventory);
      } catch (err) {
        diag?.(classifyKeyringError(err));
        return false;
      }
    }
    return true;
  }

  try {
    if (!writeKeyringDeletionGuard(keyring, account, 'deleted')) {
      diag?.('keyring deletion guard could not be verified');
      return false;
    }
    writeKeyringJournal(keyring, account, {
      mode: 'deleted',
      generations: [],
    });
    return true;
  } catch (err) {
    diag?.(classifyKeyringError(err));
    return false;
  }
}
