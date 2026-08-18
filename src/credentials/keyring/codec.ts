import { isNumber, isObject, isString } from '../../runtime/type-guards.js';
import { createHash } from 'node:crypto';
import {
  KEYRING_GENERATION_PATTERN,
  KEYRING_MAX_CHUNKS,
} from '../keyring-account.js';
import {
  classifyKeyringError,
  KEYRING_CHUNK_SERVICE,
  KEYRING_JOURNAL_SERVICE,
  KEYRING_DELETED_SERVICE,
  KEYRING_DELETED_VALUE,
  KEYRING_PENDING_DELETE_VALUE,
  KEYRING_CHUNK_PREFIX,
  KEYRING_JOURNAL_PREFIX,
  KEYRING_MAX_ENTRY_CHARS,
  KEYRING_CHUNK_SIZE,
  KEYRING_MAX_WRITE_GENERATIONS,
  KEYRING_MAX_DELETE_GENERATIONS,
  readKeyringEntry,
  deleteKeyringEntry,
} from './base.js';
import type {
  KeyringChunkMarker,
  KeyringChunkJournal,
  UntrustedKeyringChunkJournal,
  KeyringApi,
} from './base.js';
import { persistKeyringManagedState } from './state.js';
import { diagnosticRecord } from '../../observability/trace-log.js';

interface UntrustedJournalMarker {
  value: unknown;
}

export function readKeyringAccountFromService(
  keyring: KeyringApi,
  service: string,
  account: string,
  retries = 2,
): string | null {
  const value = readKeyringEntry(keyring, service, account);
  const marker = parseKeyringChunkMarker(value);
  if (!marker) return value;
  let combined: string;
  try {
    combined = readKeyringMarkerChunks(keyring, service, account, marker);
  } catch (err) {
    if (retries > 0 && readKeyringEntry(keyring, service, account) !== value) {
      return readKeyringAccountFromService(keyring, service, account, retries - 1);
    }
    throw err;
  }
  if (readKeyringEntry(keyring, service, account) !== value) {
    if (retries > 0) {
      return readKeyringAccountFromService(keyring, service, account, retries - 1);
    }
    throw new Error('keyring credential changed repeatedly while it was being read');
  }
  return combined;
}

export function readKeyringMarkerChunks(
  keyring: KeyringApi,
  service: string,
  account: string,
  marker: KeyringChunkMarker,
): string {
  let combined = '';
  const chunkService = keyringChunkService(service, marker);
  for (let i = 0; i < marker.count; i++) {
    const chunk = readKeyringEntry(keyring, chunkService, keyringChunkAccount(account, marker, i));
    if (chunk === null) {
      throw new Error(`keyring credential chunk ${i + 1} of ${marker.count} is missing`);
    }
    combined += chunk;
  }
  if (
    marker.digest
    && createHash('sha256').update(combined).digest('hex') !== marker.digest
  ) {
    throw new Error('keyring credential chunk digest does not match');
  }
  return combined;
}

export function parseKeyringChunkMarker(value: string | null): KeyringChunkMarker | null {
  if (!value?.startsWith(KEYRING_CHUNK_PREFIX)) return null;
  const encoded = value.slice(KEYRING_CHUNK_PREFIX.length);
  const current = /^v3:([^:]+):(\d+):([0-9a-f]{64})$/.exec(encoded);
  const versioned = /^v2:([^:]+):(\d+)$/.exec(encoded);
  const legacy = /^(\d+)$/.exec(encoded);
  const countText = current?.[2] ?? versioned?.[2] ?? legacy?.[1];
  const count = countText === undefined ? Number.NaN : Number(countText);
  const generation = current?.[1] ?? versioned?.[1];
  const digest = current?.[3];
  if (
    !Number.isSafeInteger(count)
    || count < 1
    || count > KEYRING_MAX_CHUNKS
    || (generation !== undefined && !KEYRING_GENERATION_PATTERN.test(generation))
  ) {
    throw new Error('keyring credential has an invalid chunk marker');
  }
  const marker: KeyringChunkMarker = { count };
  if (generation) marker.generation = generation;
  if (digest) marker.digest = digest;
  return marker;
}

export function encodeKeyringChunkMarker(marker: KeyringChunkMarker): string {
  if (!marker.generation) return `${KEYRING_CHUNK_PREFIX}${marker.count}`;
  if (marker.digest) {
    return `${KEYRING_CHUNK_PREFIX}v3:${marker.generation}:${marker.count}:${marker.digest}`;
  }
  return `${KEYRING_CHUNK_PREFIX}v2:${marker.generation}:${marker.count}`;
}

function parseJournalMarker(
  value: UntrustedJournalMarker['value'],
): KeyringChunkMarker {
  if (!value || !isObject(value)) {
    throw new Error('keyring credential has an invalid cleanup journal');
  }
  const candidate = diagnosticRecord(value);
  if (
    !isNumber(candidate.count)
    || !Number.isSafeInteger(candidate.count)
    || candidate.count < 1
    || candidate.count > KEYRING_MAX_CHUNKS
    || (
      candidate.generation !== undefined
      && (
        !isString(candidate.generation)
        || !KEYRING_GENERATION_PATTERN.test(candidate.generation)
      )
    )
    || (
      candidate.digest !== undefined
      && (
        !isString(candidate.digest)
        || !/^[0-9a-f]{64}$/.test(candidate.digest)
        || candidate.generation === undefined
      )
    )
  ) {
    throw new Error('keyring credential has an invalid cleanup journal');
  }
  const marker: KeyringChunkMarker = { count: candidate.count };
  if (candidate.generation) marker.generation = candidate.generation;
  if (candidate.digest) marker.digest = candidate.digest;
  return marker;
}

class InvalidKeyringJournalError extends Error {
  constructor() {
    super('keyring credential has an invalid cleanup journal');
    this.name = 'InvalidKeyringJournalError';
  }
}

export function parseKeyringChunkJournal(value: string): KeyringChunkJournal {
  if (!value.startsWith(KEYRING_JOURNAL_PREFIX)) {
    throw new InvalidKeyringJournalError();
  }
  try {
    const parsed: UntrustedKeyringChunkJournal = JSON.parse(
      value.slice(KEYRING_JOURNAL_PREFIX.length),
    );
    if (
      (parsed.mode !== 'write' &&
        parsed.mode !== 'short' &&
        parsed.mode !== 'delete' &&
        parsed.mode !== 'deleted') ||
      !Array.isArray(parsed.generations) ||
      parsed.generations.length >
        (parsed.mode === 'write' || parsed.mode === 'short'
          ? KEYRING_MAX_WRITE_GENERATIONS
          : KEYRING_MAX_DELETE_GENERATIONS) ||
      (parsed.mode === 'write' && parsed.generations.length < 1) ||
      (parsed.mode === 'short' &&
        (!isString(parsed.shortDigest) || !/^[0-9a-f]{64}$/.test(parsed.shortDigest))) ||
      (parsed.mode !== 'short' && parsed.mode !== 'delete' && parsed.shortDigest !== undefined) ||
      (parsed.mode === 'delete' &&
        parsed.shortDigest !== undefined &&
        (!isString(parsed.shortDigest) || !/^[0-9a-f]{64}$/.test(parsed.shortDigest))) ||
      (parsed.fallbackShortDigest !== undefined &&
        ((parsed.mode !== 'write' && parsed.mode !== 'short') ||
          !isString(parsed.fallbackShortDigest) ||
          !/^[0-9a-f]{64}$/.test(parsed.fallbackShortDigest))) ||
      (parsed.unpublished !== undefined &&
        ((parsed.mode !== 'write' && parsed.mode !== 'short') || !parsed.unpublished)) ||
      (parsed.publicationAttempted !== undefined &&
        ((parsed.mode !== 'write' && parsed.mode !== 'short') ||
          !parsed.publicationAttempted ||
          parsed.unpublished !== true)) ||
      (parsed.unpublished === true && parsed.fallbackShortDigest !== undefined) ||
      (parsed.mode === 'deleted' &&
        (parsed.generations.length > 0 ||
          parsed.shortDigest !== undefined ||
          parsed.fallbackShortDigest !== undefined ||
          parsed.unpublished !== undefined ||
          parsed.publicationAttempted !== undefined ||
          parsed.blockLegacy !== undefined ||
          parsed.unverifiable !== undefined)) ||
      (parsed.mode !== 'delete' &&
        (parsed.blockLegacy !== undefined || parsed.unverifiable !== undefined)) ||
      (parsed.blockLegacy !== undefined && !parsed.blockLegacy) ||
      (parsed.unverifiable !== undefined && !parsed.unverifiable)
    ) {
      throw new Error('invalid');
    }
    const generations = parsed.generations.map(parseJournalMarker);
    if (
      (parsed.mode === 'write' || parsed.mode === 'short') &&
      generations.some((marker, index) =>
        generations.slice(index + 1).some(candidate => sameKeyringGeneration(marker, candidate)),
      )
    ) {
      throw new Error('invalid');
    }
    const journal: KeyringChunkJournal = {
      mode: parsed.mode,
      generations,
    };
    if (parsed.shortDigest) journal.shortDigest = parsed.shortDigest;
    if (parsed.fallbackShortDigest) journal.fallbackShortDigest = parsed.fallbackShortDigest;
    if (parsed.unpublished) journal.unpublished = true;
    if (parsed.publicationAttempted) journal.publicationAttempted = true;
    if (parsed.blockLegacy) journal.blockLegacy = true;
    if (parsed.unverifiable) journal.unverifiable = true;
    return journal;
  } catch {
    throw new InvalidKeyringJournalError();
  }
}

export function sameKeyringGeneration(
  left: KeyringChunkMarker | null,
  right: KeyringChunkMarker,
): boolean {
  return (
    left !== null &&
    left.generation === right.generation &&
    Boolean(left.digest) === Boolean(right.digest)
  );
}

export function sameKeyringMarker(left: KeyringChunkMarker, right: KeyringChunkMarker): boolean {
  return (
    sameKeyringGeneration(left, right) && left.count === right.count && left.digest === right.digest
  );
}

export function appendUniqueKeyringMarker(target: KeyringChunkMarker[], marker: KeyringChunkMarker): void {
  const existing = target.find(candidate => sameKeyringGeneration(candidate, marker));
  if (!existing) {
    target.push(marker);
    return;
  }
  existing.count = Math.max(existing.count, marker.count);
  if (!existing.digest && marker.digest) existing.digest = marker.digest;
}

export function encodeKeyringJournal(journal: KeyringChunkJournal): string {
  return `${KEYRING_JOURNAL_PREFIX}${JSON.stringify(journal)}`;
}

export function keyringDeleteJournalFits(
  generations: KeyringChunkMarker[],
  unverifiable = false,
  blockLegacy = false,
  shortDigest?: string,
): boolean {
  if (generations.length > KEYRING_MAX_DELETE_GENERATIONS) {
    return false;
  }
  const journal: KeyringChunkJournal = { mode: 'delete', generations };
  if (shortDigest) journal.shortDigest = shortDigest;
  if (blockLegacy) journal.blockLegacy = true;
  if (unverifiable) journal.unverifiable = true;
  return encodeKeyringJournal(journal).length <= KEYRING_MAX_ENTRY_CHARS;
}

export function keyringChunkAccount(account: string, marker: KeyringChunkMarker, index: number): string {
  return marker.generation
    ? `${account}::chunk::${marker.generation}::${index}`
    : `${account}::chunk::${index}`;
}

function keyringChunkService(mainService: string, marker: KeyringChunkMarker): string {
  return marker.digest ? KEYRING_CHUNK_SERVICE : mainService;
}

export function splitKeyringCredential(value: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + KEYRING_CHUNK_SIZE, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

export function removeKeyringChunkRange(
  keyring: KeyringApi,
  service: string,
  account: string,
  marker: KeyringChunkMarker,
  firstIndex: number,
  diag?: (msg: string) => void,
): boolean {
  let removed = true;
  const chunkService = keyringChunkService(service, marker);
  for (let i = firstIndex; i < marker.count; i++) {
    try {
      if (!deleteKeyringEntry(keyring, chunkService, keyringChunkAccount(account, marker, i))) {
        removed = false;
      }
    } catch (err) {
      removed = false;
      diag?.(classifyKeyringError(err));
    }
  }
  return removed;
}

export function removeKeyringChunks(
  keyring: KeyringApi,
  service: string,
  account: string,
  marker: KeyringChunkMarker | null,
  diag?: (msg: string) => void,
): boolean {
  if (!marker) return true;
  return removeKeyringChunkRange(keyring, service, account, marker, 0, diag);
}

export function writeKeyringJournal(
  keyring: KeyringApi,
  account: string,
  journal: KeyringChunkJournal,
): void {
  const entry = new keyring.Entry(KEYRING_JOURNAL_SERVICE, account);
  const encoded = encodeKeyringJournal(journal);
  if (encoded.length > KEYRING_MAX_ENTRY_CHARS) {
    throw new Error('keyring cleanup journal exceeds the credential entry limit');
  }
  persistKeyringManagedState(keyring, account, { mode: 'preparing', journal });
  entry.setPassword(encoded);
  if (readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account) !== encoded) {
    throw new Error('keyring cleanup journal verification failed');
  }
  persistKeyringManagedState(keyring, account, { mode: 'managed', journal });
}

export function adoptKeyringJournal(
  keyring: KeyringApi,
  account: string,
  journal: KeyringChunkJournal,
  diag?: (msg: string) => void,
): void {
  try {
    const encoded = encodeKeyringJournal(journal);
    if (encoded.length > KEYRING_MAX_ENTRY_CHARS) {
      throw new Error('keyring cleanup journal exceeds the credential entry limit');
    }
    const entry = new keyring.Entry(KEYRING_JOURNAL_SERVICE, account);
    entry.setPassword(encoded);
    if (readKeyringEntry(keyring, KEYRING_JOURNAL_SERVICE, account) !== encoded) {
      throw new Error('keyring cleanup journal verification failed');
    }
    persistKeyringManagedState(keyring, account, { mode: 'managed', journal });
  } catch (err) {
    diag?.(classifyKeyringError(err));
  }
}

export function readKeyringDeletionGuard(
  keyring: KeyringApi,
  account: string,
): 'deleted' | 'pending' | null {
  const value = readKeyringEntry(keyring, KEYRING_DELETED_SERVICE, account);
  if (value === null) return null;
  if (value === KEYRING_DELETED_VALUE) return 'deleted';
  if (value === KEYRING_PENDING_DELETE_VALUE) return 'pending';
  throw new Error('keyring credential has an invalid deletion guard');
}

export function writeKeyringDeletionGuard(
  keyring: KeyringApi,
  account: string,
  mode: 'deleted' | 'pending',
): boolean {
  const entry = new keyring.Entry(KEYRING_DELETED_SERVICE, account);
  const value = mode === 'deleted' ? KEYRING_DELETED_VALUE : KEYRING_PENDING_DELETE_VALUE;
  entry.setPassword(value);
  return readKeyringEntry(keyring, KEYRING_DELETED_SERVICE, account) === value;
}

export function clearKeyringDeletionGuard(keyring: KeyringApi, account: string): boolean {
  return new keyring.Entry(KEYRING_DELETED_SERVICE, account).deletePassword();
}
