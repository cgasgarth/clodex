import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { getResponsesCheckpointDbPath } from '../config/paths.js';
import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import type {
  CompactionCheckpoint,
  JsonObject,
  JsonValue,
  ResponsesCheckpointStore,
  StoredCompactionCheckpoint,
} from './responses-websocket/types.js';

const SCHEMA_VERSION = 1;
const PAYLOAD_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINTS = 256;
const CHECKPOINT_KEY_PATTERN = /^[a-f0-9]{64}$/;

interface CheckpointRow {
  payload: string;
}

interface StoredPayload extends StoredCompactionCheckpoint {
  version: typeof PAYLOAD_VERSION;
}

function isStringArray(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function optionalTokenCount(value: JsonValue): boolean {
  return value === undefined
    || (isNumber(value) && Number.isSafeInteger(value) && value >= 0);
}

function isPromptFieldHashes(value: JsonValue): value is Record<string, string> {
  return isObject(value)
    && !Array.isArray(value)
    && Object.values(value).every(isString);
}

function isStoredPayload(value: JsonValue): value is JsonObject & StoredPayload {
  if (!isObject(value) || Array.isArray(value)) return false;
  const record: JsonObject = value;
  return record.version === PAYLOAD_VERSION
    && isString(record.key)
    && CHECKPOINT_KEY_PATTERN.test(record.key)
    && isString(record.lineageKey)
    && isStringArray(record.requestInputHashes)
    && isStringArray(record.requestInputKinds)
    && record.requestInputHashes.length === record.requestInputKinds.length
    && isStringArray(record.expectedAssistantHashes)
    && isStringArray(record.expectedAssistantKinds)
    && record.expectedAssistantHashes.length === record.expectedAssistantKinds.length
    && isStringArray(record.queuedEventHashes)
    && Array.isArray(record.compactedInput)
    && optionalTokenCount(record.lastInputTokens)
    && optionalTokenCount(record.postCompactionInputTokens)
    && optionalTokenCount(record.nextCompactionInputTokens)
    && (record.claudeCompactionSummaryHash === undefined
      || isString(record.claudeCompactionSummaryHash))
    && (record.promptFieldHashes === undefined
      || isPromptFieldHashes(record.promptFieldHashes))
    && isNumber(record.lastUsedAt)
    && Number.isSafeInteger(record.lastUsedAt)
    && record.lastUsedAt >= 0;
}

function payloadFromCheckpoint(checkpoint: CompactionCheckpoint): StoredPayload {
  return {
    version: PAYLOAD_VERSION,
    key: checkpoint.key,
    lineageKey: checkpoint.lineageKey,
    requestInputHashes: checkpoint.requestInputHashes,
    requestInputKinds: checkpoint.requestInputKinds,
    expectedAssistantHashes: checkpoint.expectedAssistantHashes,
    expectedAssistantKinds: checkpoint.expectedAssistantKinds,
    queuedEventHashes: checkpoint.queuedEventHashes,
    compactedInput: checkpoint.compactedInput,
    lastInputTokens: checkpoint.lastInputTokens,
    postCompactionInputTokens: checkpoint.postCompactionInputTokens,
    nextCompactionInputTokens: checkpoint.nextCompactionInputTokens,
    claudeCompactionSummaryHash: checkpoint.claudeCompactionSummaryHash,
    promptFieldHashes: checkpoint.promptFieldHashes,
    lastUsedAt: checkpoint.lastUsedAt,
  };
}

function ensureDatabasePath(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Responses checkpoint database parent must be a real directory');
  }
  try { chmodSync(directory, 0o700); } catch { /* best effort */ }
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error('Responses checkpoint database must not be a symbolic link');
    }
  } catch (error) {
    // SAFETY: Node filesystem errors expose their stable code on ErrnoException.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') return;
    throw error;
  }
}

/** SQLite storage for one current checkpoint per session partition. */
export class SqliteResponsesCheckpointStore implements ResponsesCheckpointStore {
  readonly path: string;
  private readonly db: Database;

  constructor(path: string) {
    ensureDatabasePath(path);
    this.path = path;
    this.db = new Database(path, { create: true, strict: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        last_used_at_ms INTEGER NOT NULL
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS checkpoints_recency ON checkpoints(last_used_at_ms)');
    const schema = this.db.query<{ version: number }, []>(
      'SELECT version FROM schema_meta LIMIT 1',
    ).get();
    if (schema && schema.version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`Unsupported Responses checkpoint schema: ${schema.version}`);
    }
    if (!schema) this.db.query('INSERT INTO schema_meta(version) VALUES (?)').run(SCHEMA_VERSION);
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  load(key: string, now: number): StoredCompactionCheckpoint | undefined {
    if (!CHECKPOINT_KEY_PATTERN.test(key)) return undefined;
    const row = this.db.query<CheckpointRow, [string]>(`
      SELECT payload FROM checkpoints WHERE checkpoint_key = ?
    `).get(key);
    if (!row) return undefined;
    try {
      // SAFETY: JSON.parse can only produce values in the JsonValue domain.
      const parsed = JSON.parse(row.payload) as JsonValue;
      if (!isStoredPayload(parsed) || parsed.key !== key) throw new Error('checkpoint is invalid');
      const { version: _version, ...checkpoint } = parsed;
      this.db.query(`
        UPDATE checkpoints SET last_used_at_ms = ? WHERE checkpoint_key = ?
      `).run(now, key);
      return { ...checkpoint, lastUsedAt: now };
    } catch {
      this.delete(key);
      return undefined;
    }
  }

  save(checkpoint: CompactionCheckpoint): boolean {
    if (!CHECKPOINT_KEY_PATTERN.test(checkpoint.key)) return false;
    const payload = JSON.stringify(payloadFromCheckpoint(checkpoint));
    if (Buffer.byteLength(payload, 'utf8') > MAX_CHECKPOINT_BYTES) return false;
    const persist = this.db.transaction(() => {
      const write = this.db.query(`
        INSERT INTO checkpoints(checkpoint_key, payload, last_used_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(checkpoint_key) DO UPDATE SET
          payload = excluded.payload,
          last_used_at_ms = excluded.last_used_at_ms
        WHERE excluded.last_used_at_ms >= checkpoints.last_used_at_ms
      `).run(checkpoint.key, payload, checkpoint.lastUsedAt);
      this.db.query(`
        DELETE FROM checkpoints WHERE checkpoint_key IN (
          SELECT checkpoint_key FROM checkpoints
          ORDER BY last_used_at_ms DESC LIMIT -1 OFFSET ?
        )
      `).run(MAX_CHECKPOINTS);
      return write.changes > 0;
    });
    return persist();
  }

  delete(key: string): void {
    this.db.query('DELETE FROM checkpoints WHERE checkpoint_key = ?').run(key);
  }

  size(): number {
    return this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM checkpoints').get()?.count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

const defaultStores = new Map<string, SqliteResponsesCheckpointStore>();

export function getDefaultResponsesCheckpointStore(
  path = getResponsesCheckpointDbPath(),
): SqliteResponsesCheckpointStore {
  let store = defaultStores.get(path);
  if (!store) {
    store = new SqliteResponsesCheckpointStore(path);
    defaultStores.set(path, store);
  }
  return store;
}
