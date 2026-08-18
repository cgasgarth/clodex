import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const STORE_VERSION = 2;
// Native compact output can legitimately retain a large, dependency-closed
// tool tail (screenshots and workflow results are the common case). Refusing
// those records makes an otherwise healthy session unrecoverable after a
// daemon restart. Keep a defensive bound, but size it for real Claude sessions.
const MAX_CHECKPOINT_FILE_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_FILE_SUFFIX = '.json';
const CHECKPOINT_KEY_PATTERN = /^[a-f0-9]{64}$/;
const LINEAGE_KEY_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CHECKPOINT_FILE_PATTERN =
  /^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;

export interface StoredResponsesCheckpointFile {
  checkpointKey: string;
  lineageKey: string;
  mtimeMs: number;
}

export interface StoredResponsesCheckpoint {
  version: typeof STORE_VERSION;
  checkpointKey: string;
  lineageKey: string;
  requestInputHashes: string[];
  requestInputKinds: string[];
  expectedAssistantHashes: string[];
  expectedAssistantKinds: string[];
  compactedInput: unknown[];
  lastInputTokens?: number;
  postCompactionInputTokens?: number;
  nextCompactionInputTokens?: number;
  claudeCompactionSummaryHash?: string;
  promptFieldHashes?: Record<string, string>;
  lastUsedAt: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isStoredCheckpoint(value: unknown): value is StoredResponsesCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === STORE_VERSION
    && typeof record.checkpointKey === 'string'
    && CHECKPOINT_KEY_PATTERN.test(record.checkpointKey)
    && typeof record.lineageKey === 'string'
    && LINEAGE_KEY_PATTERN.test(record.lineageKey)
    && isStringArray(record.requestInputHashes)
    && isStringArray(record.requestInputKinds)
    && record.requestInputHashes.length === record.requestInputKinds.length
    && isStringArray(record.expectedAssistantHashes)
    && isStringArray(record.expectedAssistantKinds)
    && record.expectedAssistantHashes.length === record.expectedAssistantKinds.length
    && Array.isArray(record.compactedInput)
    && (record.postCompactionInputTokens === undefined
      || (typeof record.postCompactionInputTokens === 'number'
        && Number.isSafeInteger(record.postCompactionInputTokens)
        && record.postCompactionInputTokens >= 0))
    && (record.nextCompactionInputTokens === undefined
      || (typeof record.nextCompactionInputTokens === 'number'
        && Number.isSafeInteger(record.nextCompactionInputTokens)
        && record.nextCompactionInputTokens > 0))
    && typeof record.lastUsedAt === 'number';
}

function checkpointPath(directory: string, checkpointKey: string, lineageKey: string): string {
  if (!CHECKPOINT_KEY_PATTERN.test(checkpointKey) || !LINEAGE_KEY_PATTERN.test(lineageKey)) {
    throw new Error('Invalid Responses checkpoint identity');
  }
  return join(directory, `${checkpointKey}-${lineageKey}${CHECKPOINT_FILE_SUFFIX}`);
}

function checkpointIdentity(name: string): Pick<StoredResponsesCheckpointFile, 'checkpointKey' | 'lineageKey'> | undefined {
  if (!CHECKPOINT_FILE_PATTERN.test(name)) return undefined;
  const checkpointKey = name.slice(0, 64);
  const lineageKey = name.slice(65, -CHECKPOINT_FILE_SUFFIX.length);
  return { checkpointKey, lineageKey };
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Responses checkpoint store must be a real directory');
  }
  try { chmodSync(directory, 0o700); } catch { /* best effort on restricted platforms */ }
}

export function loadStoredResponsesCheckpoints(
  directory: string,
  now: number,
  ttlMs: number,
): StoredResponsesCheckpoint[] {
  if (!existsSync(directory)) return [];
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Responses checkpoint store must be a real directory');
  }
  try { chmodSync(directory, 0o700); } catch { /* best effort */ }
  const loaded: StoredResponsesCheckpoint[] = [];
  for (const name of readdirSync(directory)) {
    // Never inspect or delete unrelated JSON files if a user points the store
    // at a broader directory by mistake.
    if (!CHECKPOINT_FILE_PATTERN.test(name)) continue;
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHECKPOINT_FILE_BYTES) {
        rmSync(path, { force: true });
        continue;
      }
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isStoredCheckpoint(parsed) || now - parsed.lastUsedAt >= ttlMs) {
        rmSync(path, { force: true });
        continue;
      }
      loaded.push(parsed);
    } catch {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }
  return loaded;
}

export function listStoredResponsesCheckpointFiles(
  directory: string,
  now: number,
  ttlMs: number,
): StoredResponsesCheckpointFile[] {
  if (!existsSync(directory)) return [];
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Responses checkpoint store must be a real directory');
  }
  try { chmodSync(directory, 0o700); } catch { /* best effort */ }
  const files: StoredResponsesCheckpointFile[] = [];
  for (const name of readdirSync(directory)) {
    const identity = checkpointIdentity(name);
    if (!identity) continue;
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.size > MAX_CHECKPOINT_FILE_BYTES
        || now - stat.mtimeMs >= ttlMs
      ) {
        rmSync(path, { force: true });
        continue;
      }
      files.push({ ...identity, mtimeMs: stat.mtimeMs });
    } catch {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }
  return files;
}

export function loadStoredResponsesCheckpoint(
  directory: string,
  checkpointKey: string,
  lineageKey: string,
): StoredResponsesCheckpoint | undefined {
  try {
    const path = checkpointPath(directory, checkpointKey, lineageKey);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHECKPOINT_FILE_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isStoredCheckpoint(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveStoredResponsesCheckpoint(
  directory: string,
  checkpoint: StoredResponsesCheckpoint,
  maxPerPartition: number,
  maxTotal: number,
): boolean {
  const serialized = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_FILE_BYTES) return false;
  ensurePrivateDirectory(directory);
  const path = checkpointPath(directory, checkpoint.checkpointKey, checkpoint.lineageKey);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    const files = readdirSync(directory)
      .filter(name => CHECKPOINT_FILE_PATTERN.test(name))
      .map(name => {
        const candidatePath = join(directory, name);
        try {
          const stat = lstatSync(candidatePath);
          return stat.isFile() && !stat.isSymbolicLink()
            ? { name, path: candidatePath, mtimeMs: stat.mtimeMs }
            : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((candidate): candidate is { name: string; path: string; mtimeMs: number } => Boolean(candidate));
    const partitionPrefix = `${checkpoint.checkpointKey}-`;
    const partitionExcess = files
      .filter(candidate => candidate.name.startsWith(partitionPrefix))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(maxPerPartition);
    for (const candidate of partitionExcess) rmSync(candidate.path, { force: true });
    const globalExcess = files
      .filter(candidate => !partitionExcess.some(removed => removed.path === candidate.path))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(maxTotal);
    for (const candidate of globalExcess) rmSync(candidate.path, { force: true });
    return true;
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* ignore */ }
  }
}

export function deleteStoredResponsesCheckpoint(
  directory: string,
  checkpointKey: string,
  lineageKey: string,
): void {
  try {
    if (!existsSync(directory)) return;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    rmSync(checkpointPath(directory, checkpointKey, lineageKey), { force: true });
  } catch { /* ignore */ }
}
