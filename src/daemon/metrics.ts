import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  getDaemonMetricsDbPath,
  getDaemonMetricsPath,
} from '../paths.js';
import {
  effectiveApiProcessingMode,
  estimateApiCost,
  normalizeApiProcessingMode,
  type ApiProcessingMode,
  type ApiCostBreakdown,
} from './api-pricing.js';

const METRICS_RETENTION_MS = 400 * 24 * 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;
const METRICS_SCHEMA_VERSION = 2;

export interface DaemonMetricEvent {
  timestamp: string;
  requestId?: string;
  sessionHash?: string;
  accountId?: string;
  processingMode?: ApiProcessingMode;
  modelId: string;
  provider: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  durationMs?: number;
  error: boolean;
  cancelled?: boolean;
}

export interface DaemonMetricBucket {
  timestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  requests: number;
  errors: number;
  cancellations: number;
  durationMs: number;
  inputCost: number;
  cacheCost: number;
  outputCost: number;
  totalCost: number;
  pricedRequests: number;
  unpricedRequests: number;
  standardRequests: number;
  fastRequests: number;
  standardCost: number;
  fastCost: number;
}

interface MetricRow {
  timestamp_ms: number;
  timestamp: string;
  request_id: string | null;
  session_hash: string | null;
  account_id: string | null;
  processing_mode: string;
  model_id: string;
  provider: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  duration_ms: number | null;
  error: number;
  cancelled: number;
}

interface DaemonMetricsStoreOptions {
  legacyPath?: string;
  now?: () => number;
}

export function hashSessionId(value: string | undefined): string | undefined {
  return value
    ? createHash('sha256').update(value).digest('hex').slice(0, 16)
    : undefined;
}

function safeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function safeIdentifier(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
}

function parseMetricLine(line: string): DaemonMetricEvent | null {
  try {
    const value = JSON.parse(line) as Partial<DaemonMetricEvent>;
    if (
      typeof value.timestamp !== 'string'
      || !Number.isFinite(Date.parse(value.timestamp))
      || typeof value.modelId !== 'string'
      || typeof value.provider !== 'string'
    ) return null;
    return {
      timestamp: value.timestamp,
      ...(safeIdentifier(value.requestId, 100) ? { requestId: safeIdentifier(value.requestId, 100) } : {}),
      ...(safeIdentifier(value.sessionHash, 32) ? { sessionHash: safeIdentifier(value.sessionHash, 32) } : {}),
      ...(safeIdentifier(value.accountId, 100) ? { accountId: safeIdentifier(value.accountId, 100) } : {}),
      processingMode: normalizeApiProcessingMode(value.processingMode),
      modelId: value.modelId.slice(0, 200),
      provider: value.provider.slice(0, 100),
      inputTokens: safeInteger(value.inputTokens),
      cachedInputTokens: safeInteger(value.cachedInputTokens),
      cacheWriteTokens: safeInteger(value.cacheWriteTokens),
      outputTokens: safeInteger(value.outputTokens),
      ...(value.durationMs !== undefined ? { durationMs: safeInteger(value.durationMs) } : {}),
      error: value.error === true,
      cancelled: value.cancelled === true,
    };
  } catch {
    return null;
  }
}

function rowToEvent(row: MetricRow): DaemonMetricEvent {
  return {
    timestamp: row.timestamp,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.session_hash ? { sessionHash: row.session_hash } : {}),
    ...(row.account_id ? { accountId: row.account_id } : {}),
    processingMode: normalizeApiProcessingMode(row.processing_mode),
    modelId: row.model_id,
    provider: row.provider,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    error: row.error === 1,
    cancelled: row.cancelled === 1,
  };
}

function emptyBucket(timestampMs: number): DaemonMetricBucket {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    requests: 0,
    errors: 0,
    cancellations: 0,
    durationMs: 0,
    inputCost: 0,
    cacheCost: 0,
    outputCost: 0,
    totalCost: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    standardRequests: 0,
    fastRequests: 0,
    standardCost: 0,
    fastCost: 0,
  };
}

function addCost(
  bucket: DaemonMetricBucket,
  cost: ApiCostBreakdown | undefined,
  processingMode: ApiProcessingMode,
): void {
  if (!cost) {
    bucket.unpricedRequests += 1;
    return;
  }
  bucket.pricedRequests += 1;
  if (processingMode === 'fast') {
    bucket.fastRequests += 1;
    bucket.fastCost += cost.total;
  } else {
    bucket.standardRequests += 1;
    bucket.standardCost += cost.total;
  }
  bucket.inputCost += cost.input;
  bucket.cacheCost += cost.cache;
  bucket.outputCost += cost.output;
  bucket.totalCost += cost.total;
}

export class DaemonMetricsStore {
  readonly path: string;
  readonly legacyPath?: string;
  private readonly db: Database;
  private readonly now: () => number;
  private lastPrunedAt = 0;

  constructor(
    path = getDaemonMetricsDbPath(),
    options: DaemonMetricsStoreOptions = {},
  ) {
    this.path = path;
    this.legacyPath = options.legacyPath
      ?? (path === getDaemonMetricsDbPath() ? getDaemonMetricsPath() : undefined);
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metric_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        request_id TEXT,
        session_hash TEXT,
        account_id TEXT,
        processing_mode TEXT NOT NULL DEFAULT 'standard',
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        duration_ms INTEGER,
        error INTEGER NOT NULL,
        cancelled INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS metric_events_timestamp
        ON metric_events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS metric_events_account_timestamp
        ON metric_events(account_id, timestamp_ms);
    `);
    let schema = this.db.query<{ version: number }, []>(
      'SELECT version FROM schema_meta LIMIT 1',
    ).get();
    if (schema?.version === 1) {
      this.db.exec(`
        ALTER TABLE metric_events
          ADD COLUMN processing_mode TEXT NOT NULL DEFAULT 'standard';
        UPDATE schema_meta SET version = 2;
      `);
      schema = { version: 2 };
    }
    if (schema && schema.version !== METRICS_SCHEMA_VERSION) {
      throw new Error(`Unsupported daemon metrics schema: ${schema.version}`);
    }
    if (!schema) {
      this.db.query('INSERT INTO schema_meta(version) VALUES (?)')
        .run(METRICS_SCHEMA_VERSION);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    this.migrateLegacyJsonl();
    this.prune(this.now(), true);
  }

  append(event: DaemonMetricEvent): void {
    try {
      const timestampMs = Date.parse(event.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs < this.now() - METRICS_RETENTION_MS) return;
      this.insert(event);
      this.prune(this.now());
    } catch {
      // Metrics must never alter inference behavior.
    }
  }

  readSince(sinceMs: number, accountId?: string): DaemonMetricEvent[] {
    const rows = accountId
      ? this.db.query<MetricRow, [number, string]>(`
          SELECT * FROM metric_events
          WHERE timestamp_ms >= ? AND account_id = ?
          ORDER BY timestamp_ms, id
        `).all(sinceMs, accountId)
      : this.db.query<MetricRow, [number]>(`
          SELECT * FROM metric_events
          WHERE timestamp_ms >= ?
          ORDER BY timestamp_ms, id
        `).all(sinceMs);
    return rows.map(rowToEvent);
  }

  buckets(
    windowMs = 24 * 60 * 60_000,
    bucketMs = FIVE_MINUTES_MS,
    now = this.now(),
    accountId?: string,
  ): DaemonMetricBucket[] {
    return this.bucketsRange(now - windowMs, now, bucketMs, accountId);
  }

  bucketsRange(
    startMs: number,
    endMs: number,
    bucketMs: number,
    accountId?: string,
  ): DaemonMetricBucket[] {
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || !Number.isFinite(bucketMs)
      || endMs <= startMs
      || bucketMs <= 0
    ) return [];
    const bucketCount = Math.ceil((endMs - startMs) / bucketMs);
    const buckets = Array.from(
      { length: bucketCount },
      (_, index) => emptyBucket(startMs + index * bucketMs),
    );
    const rows = accountId
      ? this.db.query<MetricRow, [number, number, string]>(`
          SELECT * FROM metric_events
          WHERE timestamp_ms >= ? AND timestamp_ms < ? AND account_id = ?
          ORDER BY timestamp_ms, id
        `).all(startMs, endMs, accountId)
      : this.db.query<MetricRow, [number, number]>(`
          SELECT * FROM metric_events
          WHERE timestamp_ms >= ? AND timestamp_ms < ?
          ORDER BY timestamp_ms, id
        `).all(startMs, endMs);
    for (const row of rows) {
      const index = Math.floor((row.timestamp_ms - startMs) / bucketMs);
      const bucket = buckets[index];
      if (!bucket) continue;
      bucket.inputTokens += row.input_tokens;
      bucket.cachedInputTokens += row.cached_input_tokens;
      bucket.cacheWriteTokens += row.cache_write_tokens;
      bucket.outputTokens += row.output_tokens;
      bucket.requests += 1;
      bucket.errors += row.error;
      bucket.cancellations += row.cancelled;
      bucket.durationMs += row.duration_ms ?? 0;
      const usage = {
        modelId: row.model_id,
        processingMode: normalizeApiProcessingMode(row.processing_mode),
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        outputTokens: row.output_tokens,
      };
      const processingMode = effectiveApiProcessingMode(usage);
      addCost(bucket, estimateApiCost({
        ...usage,
      }), processingMode);
    }
    return buckets;
  }

  close(): void {
    this.db.close();
  }

  private insert(event: DaemonMetricEvent): void {
    const timestampMs = Date.parse(event.timestamp);
    if (!Number.isFinite(timestampMs)) return;
    this.db.query(`
      INSERT INTO metric_events (
        timestamp_ms, timestamp, request_id, session_hash, account_id, processing_mode,
        model_id, provider, input_tokens, cached_input_tokens,
        cache_write_tokens, output_tokens, duration_ms, error, cancelled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      timestampMs,
      event.timestamp,
      event.requestId ?? null,
      event.sessionHash ?? null,
      event.accountId ?? null,
      normalizeApiProcessingMode(event.processingMode),
      event.modelId.slice(0, 200),
      event.provider.slice(0, 100),
      safeInteger(event.inputTokens),
      safeInteger(event.cachedInputTokens),
      safeInteger(event.cacheWriteTokens),
      safeInteger(event.outputTokens),
      event.durationMs === undefined ? null : safeInteger(event.durationMs),
      event.error ? 1 : 0,
      event.cancelled ? 1 : 0,
    );
  }

  private migrateLegacyJsonl(): void {
    if (!this.legacyPath) return;
    const existing = this.db.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM metric_events',
    ).get()?.count ?? 0;
    if (existing > 0) return;
    const paths = [`${this.legacyPath}.1`, this.legacyPath];
    const events = paths.flatMap(path => {
      if (!existsSync(path)) return [];
      try {
        return readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(parseMetricLine)
          .filter((event): event is DaemonMetricEvent => Boolean(event));
      } catch {
        return [];
      }
    });
    if (events.length === 0) return;
    const migrate = this.db.transaction((values: DaemonMetricEvent[]) => {
      for (const event of values) this.insert(event);
    });
    migrate.immediate(events);
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch {
        // Imported SQLite rows are durable; a concurrently missing source is harmless.
      }
    }
  }

  private prune(now: number, force = false): void {
    if (!force && now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.db.query('DELETE FROM metric_events WHERE timestamp_ms < ?')
      .run(now - METRICS_RETENTION_MS);
    this.lastPrunedAt = now;
  }
}
