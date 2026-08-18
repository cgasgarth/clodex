import { isNumber, isObject, isString } from '../runtime/type-guards.js';
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
} from '../config/paths.js';
import {
  effectiveApiProcessingMode,
  estimateApiCost,
  normalizeApiProcessingMode,
  type ApiProcessingMode,
  type ApiCostBreakdown,
} from './api-pricing.js';
import type { JsonValue } from '../oauth/responses-websocket/types.js';

declare global {
  interface Array<T> {
    toSorted(compareFn?: (left: T, right: T) => number): T[];
  }
}

const METRICS_RETENTION_MS = 400 * 24 * 60 * 60_000;
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;
const METRICS_FLUSH_INTERVAL_MS = ONE_MINUTE_MS;
const METRICS_FLUSH_BATCH_SIZE = 1_000;
const METRICS_SCHEMA_VERSION = 3;

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

export interface SecondwindLifetimeMetrics {
  requests: number;
  blocksRewritten: number;
  inputTokensConsidered: number;
  tokensReduced: number;
  estimatedTokenRequests: number;
  estimatedSavingsUsd: number;
  observedInputTokens: number;
  savedInputTokens: number;
  savedCachedInputTokens: number;
  savedCacheWriteTokens: number;
  estimatedInputSavingsUsd: number;
  estimatedCacheSavingsUsd: number;
  estimatedOutputSavingsUsd: number;
}

export interface SecondwindSavingsEvent {
  requests: number;
  blocksRewritten: number;
  inputTokensConsidered: number;
  tokensReduced: number;
  estimatedTokenRequests: number;
  estimatedSavingsUsd: number;
  observedInputTokens: number;
  savedInputTokens: number;
  savedCachedInputTokens: number;
  savedCacheWriteTokens: number;
  estimatedInputSavingsUsd: number;
  estimatedCacheSavingsUsd: number;
  estimatedOutputSavingsUsd: number;
}

type SecondwindSavingsInput = Pick<SecondwindSavingsEvent,
  'requests' | 'blocksRewritten' | 'inputTokensConsidered' | 'tokensReduced'
  | 'estimatedTokenRequests' | 'estimatedSavingsUsd'>
  & Partial<Omit<SecondwindSavingsEvent,
    'requests' | 'blocksRewritten' | 'inputTokensConsidered' | 'tokensReduced'
    | 'estimatedTokenRequests' | 'estimatedSavingsUsd'>>;

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

interface PersistedMetricAggregate extends DaemonMetricBucket {
  timestampMs: number;
  accountId?: string;
  processingMode: ApiProcessingMode;
  modelId: string;
  provider: string;
}

interface MetricBatchRow {
  payload: string;
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

function safeInteger(value: JsonValue): number {
  return isNumber(value) && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function safeIdentifier(value: JsonValue, max: number): string | undefined {
  return isString(value) && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
}

function parseMetricLine(line: string): DaemonMetricEvent | null {
  try {
    const value: Partial<DaemonMetricEvent> = JSON.parse(line);
    if (
      !isString(value.timestamp)
      || !Number.isFinite(Date.parse(value.timestamp))
      || !isString(value.modelId)
      || !isString(value.provider)
    ) return null;
    const event: DaemonMetricEvent = {
      timestamp: value.timestamp,
      processingMode: normalizeApiProcessingMode(value.processingMode),
      modelId: value.modelId.slice(0, 200),
      provider: value.provider.slice(0, 100),
      inputTokens: safeInteger(value.inputTokens),
      cachedInputTokens: safeInteger(value.cachedInputTokens),
      cacheWriteTokens: safeInteger(value.cacheWriteTokens),
      outputTokens: safeInteger(value.outputTokens),
      error: value.error === true,
      cancelled: value.cancelled === true,
    };
    const requestId = safeIdentifier(value.requestId, 100);
    const sessionHash = safeIdentifier(value.sessionHash, 32);
    const accountId = safeIdentifier(value.accountId, 100);
    if (requestId) event.requestId = requestId;
    if (sessionHash) event.sessionHash = sessionHash;
    if (accountId) event.accountId = accountId;
    if (value.durationMs !== undefined) event.durationMs = safeInteger(value.durationMs);
    return event;
  } catch {
    return null;
  }
}

function rowToEvent(row: MetricRow): DaemonMetricEvent {
  const event: DaemonMetricEvent = {
    timestamp: row.timestamp,
    processingMode: normalizeApiProcessingMode(row.processing_mode),
    modelId: row.model_id,
    provider: row.provider,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    error: row.error === 1,
    cancelled: row.cancelled === 1,
  };
  if (row.request_id) event.requestId = row.request_id;
  if (row.session_hash) event.sessionHash = row.session_hash;
  if (row.account_id) event.accountId = row.account_id;
  if (row.duration_ms !== null) event.durationMs = row.duration_ms;
  return event;
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

function metricAggregateKey(event: DaemonMetricEvent, timestampMs: number): string {
  return JSON.stringify([
    timestampMs,
    event.accountId ?? '',
    normalizeApiProcessingMode(event.processingMode),
    event.modelId,
    event.provider,
  ]);
}

function aggregateMetricEvents(events: DaemonMetricEvent[]): PersistedMetricAggregate[] {
  const aggregates = new Map<string, PersistedMetricAggregate>();
  for (const event of events) {
    const eventMs = Date.parse(event.timestamp);
    if (!Number.isFinite(eventMs)) continue;
    const timestampMs = Math.floor(eventMs / ONE_MINUTE_MS) * ONE_MINUTE_MS;
    const processingMode = normalizeApiProcessingMode(event.processingMode);
    const key = metricAggregateKey(event, timestampMs);
    const aggregate = aggregates.get(key) ?? {
      ...emptyBucket(timestampMs),
      timestampMs,
      processingMode,
      modelId: event.modelId,
      provider: event.provider,
    };
    if (event.accountId) aggregate.accountId = event.accountId;
    aggregate.inputTokens += safeInteger(event.inputTokens);
    aggregate.cachedInputTokens += safeInteger(event.cachedInputTokens);
    aggregate.cacheWriteTokens += safeInteger(event.cacheWriteTokens);
    aggregate.outputTokens += safeInteger(event.outputTokens);
    aggregate.requests += 1;
    aggregate.errors += event.error ? 1 : 0;
    aggregate.cancellations += event.cancelled ? 1 : 0;
    aggregate.durationMs += safeInteger(event.durationMs);
    const usage = {
      modelId: event.modelId,
      processingMode,
      inputTokens: safeInteger(event.inputTokens),
      cachedInputTokens: safeInteger(event.cachedInputTokens),
      cacheWriteTokens: safeInteger(event.cacheWriteTokens),
      outputTokens: safeInteger(event.outputTokens),
    };
    addCost(aggregate, estimateApiCost(usage), effectiveApiProcessingMode(usage));
    aggregates.set(key, aggregate);
  }
  return [...aggregates.values()].toSorted((left, right) =>
    left.timestampMs - right.timestampMs
    || (left.accountId ?? '').localeCompare(right.accountId ?? '')
    || left.modelId.localeCompare(right.modelId)
    || left.processingMode.localeCompare(right.processingMode));
}

function parseMetricBatch(payload: string): PersistedMetricAggregate[] {
  try {
    const values: JsonValue = JSON.parse(payload);
    if (!Array.isArray(values)) return [];
    return values.flatMap(value => normalizePersistedMetricAggregate(value));
  } catch {
    return [];
  }
}

interface PersistedMetricInput {
  timestampMs?: JsonValue;
  timestamp?: JsonValue;
  accountId?: JsonValue;
  processingMode?: JsonValue;
  modelId?: JsonValue;
  provider?: JsonValue;
  inputTokens?: JsonValue;
  cachedInputTokens?: JsonValue;
  cacheWriteTokens?: JsonValue;
  outputTokens?: JsonValue;
  requests?: JsonValue;
  errors?: JsonValue;
  cancellations?: JsonValue;
  durationMs?: JsonValue;
  inputCost?: JsonValue;
  cacheCost?: JsonValue;
  outputCost?: JsonValue;
  totalCost?: JsonValue;
  pricedRequests?: JsonValue;
  unpricedRequests?: JsonValue;
  standardRequests?: JsonValue;
  fastRequests?: JsonValue;
  standardCost?: JsonValue;
  fastCost?: JsonValue;
}

function normalizePersistedMetricAggregate(value: JsonValue): PersistedMetricAggregate[] {
  if (!value || !isObject(value) || Array.isArray(value)) return [];
  const row: PersistedMetricInput = value;
  if (!Number.isFinite(row.timestampMs)
    || !isString(row.modelId)
    || !isString(row.provider)) return [];
  const timestampMs = Number(row.timestampMs);
  const bucket = emptyBucket(timestampMs);
  const aggregate: PersistedMetricAggregate = {
    ...bucket,
    timestamp: isString(row.timestamp) ? row.timestamp : bucket.timestamp,
    timestampMs,
    processingMode: normalizeApiProcessingMode(row.processingMode),
    modelId: row.modelId,
    provider: row.provider,
    inputTokens: safeInteger(row.inputTokens),
    cachedInputTokens: safeInteger(row.cachedInputTokens),
    cacheWriteTokens: safeInteger(row.cacheWriteTokens),
    outputTokens: safeInteger(row.outputTokens),
    requests: safeInteger(row.requests),
    errors: safeInteger(row.errors),
    cancellations: safeInteger(row.cancellations),
    durationMs: safeInteger(row.durationMs),
    inputCost: safeAmount(row.inputCost),
    cacheCost: safeAmount(row.cacheCost),
    outputCost: safeAmount(row.outputCost),
    totalCost: safeAmount(row.totalCost),
    pricedRequests: safeInteger(row.pricedRequests),
    unpricedRequests: safeInteger(row.unpricedRequests),
    standardRequests: safeInteger(row.standardRequests),
    fastRequests: safeInteger(row.fastRequests),
    standardCost: safeAmount(row.standardCost),
    fastCost: safeAmount(row.fastCost),
  };
  if (isString(row.accountId)) aggregate.accountId = row.accountId;
  return [aggregate];
}

function safeAmount(value: JsonValue): number {
  return isNumber(value) && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function addAggregate(
  bucket: DaemonMetricBucket,
  aggregate: PersistedMetricAggregate,
): void {
  bucket.inputTokens += safeInteger(aggregate.inputTokens);
  bucket.cachedInputTokens += safeInteger(aggregate.cachedInputTokens);
  bucket.cacheWriteTokens += safeInteger(aggregate.cacheWriteTokens);
  bucket.outputTokens += safeInteger(aggregate.outputTokens);
  bucket.requests += safeInteger(aggregate.requests);
  bucket.errors += safeInteger(aggregate.errors);
  bucket.cancellations += safeInteger(aggregate.cancellations);
  bucket.durationMs += safeInteger(aggregate.durationMs);
  bucket.inputCost += Math.max(0, aggregate.inputCost);
  bucket.cacheCost += Math.max(0, aggregate.cacheCost);
  bucket.outputCost += Math.max(0, aggregate.outputCost);
  bucket.totalCost += Math.max(0, aggregate.totalCost);
  bucket.pricedRequests += safeInteger(aggregate.pricedRequests);
  bucket.unpricedRequests += safeInteger(aggregate.unpricedRequests);
  bucket.standardRequests += safeInteger(aggregate.standardRequests);
  bucket.fastRequests += safeInteger(aggregate.fastRequests);
  bucket.standardCost += Math.max(0, aggregate.standardCost);
  bucket.fastCost += Math.max(0, aggregate.fastCost);
}

function sumSecondwindSavings(
  events: SecondwindSavingsInput[],
): SecondwindSavingsEvent {
  return events.reduce<SecondwindSavingsEvent>(
    (sum, event) => ({
      requests: sum.requests + safeInteger(event.requests),
      blocksRewritten: sum.blocksRewritten + safeInteger(event.blocksRewritten),
      inputTokensConsidered:
        sum.inputTokensConsidered + safeInteger(event.inputTokensConsidered),
      tokensReduced: sum.tokensReduced + safeInteger(event.tokensReduced),
      estimatedTokenRequests:
        sum.estimatedTokenRequests + safeInteger(event.estimatedTokenRequests),
      estimatedSavingsUsd: sum.estimatedSavingsUsd
        + (Number.isFinite(event.estimatedSavingsUsd)
          ? Math.max(0, event.estimatedSavingsUsd)
          : 0),
      observedInputTokens: sum.observedInputTokens + safeInteger(event.observedInputTokens),
      savedInputTokens: sum.savedInputTokens + safeInteger(event.savedInputTokens),
      savedCachedInputTokens:
        sum.savedCachedInputTokens + safeInteger(event.savedCachedInputTokens),
      savedCacheWriteTokens:
        sum.savedCacheWriteTokens + safeInteger(event.savedCacheWriteTokens),
      estimatedInputSavingsUsd: sum.estimatedInputSavingsUsd
        + Math.max(0, event.estimatedInputSavingsUsd ?? 0),
      estimatedCacheSavingsUsd: sum.estimatedCacheSavingsUsd
        + Math.max(0, event.estimatedCacheSavingsUsd ?? 0),
      estimatedOutputSavingsUsd: sum.estimatedOutputSavingsUsd
        + Math.max(0, event.estimatedOutputSavingsUsd ?? 0),
    }),
    {
      requests: 0,
      blocksRewritten: 0,
      inputTokensConsidered: 0,
      tokensReduced: 0,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0,
      observedInputTokens: 0,
      savedInputTokens: 0,
      savedCachedInputTokens: 0,
      savedCacheWriteTokens: 0,
      estimatedInputSavingsUsd: 0,
      estimatedCacheSavingsUsd: 0,
      estimatedOutputSavingsUsd: 0,
    },
  );
}

export class DaemonMetricsStore {
  readonly path: string;
  readonly legacyPath?: string;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly pendingEvents: DaemonMetricEvent[] = [];
  private readonly pendingSecondwind: SecondwindSavingsInput[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
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
      CREATE TABLE IF NOT EXISTS metric_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS metric_batches_range
        ON metric_batches(start_ms, end_ms);
      CREATE TABLE IF NOT EXISTS secondwind_lifetime (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        requests INTEGER NOT NULL,
        blocks_rewritten INTEGER NOT NULL,
        input_tokens_considered INTEGER NOT NULL,
        tokens_reduced INTEGER NOT NULL,
        estimated_token_requests INTEGER NOT NULL,
        estimated_savings_usd REAL NOT NULL,
        observed_input_tokens INTEGER NOT NULL DEFAULT 0,
        saved_input_tokens INTEGER NOT NULL DEFAULT 0,
        saved_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        saved_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_input_savings_usd REAL NOT NULL DEFAULT 0,
        estimated_cache_savings_usd REAL NOT NULL DEFAULT 0,
        estimated_output_savings_usd REAL NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO secondwind_lifetime (
        singleton, requests, blocks_rewritten, input_tokens_considered, tokens_reduced,
        estimated_token_requests, estimated_savings_usd
      ) VALUES (1, 0, 0, 0, 0, 0, 0);
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
    if (schema?.version === 2) {
      const existing = new Set(this.db.query<{ name: string }, []>(
        'PRAGMA table_info(secondwind_lifetime)',
      ).all().map(column => column.name));
      const columns = [
        ['observed_input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
        ['saved_input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
        ['saved_cached_input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
        ['saved_cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0'],
        ['estimated_input_savings_usd', 'REAL NOT NULL DEFAULT 0'],
        ['estimated_cache_savings_usd', 'REAL NOT NULL DEFAULT 0'],
        ['estimated_output_savings_usd', 'REAL NOT NULL DEFAULT 0'],
      ] as const;
      for (const [name, definition] of columns) {
        if (!existing.has(name)) {
          this.db.exec(`ALTER TABLE secondwind_lifetime ADD COLUMN ${name} ${definition}`);
        }
      }
      this.db.exec('UPDATE schema_meta SET version = 3');
      schema = { version: 3 };
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
      this.pendingEvents.push(event);
      this.scheduleFlush();
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
    const persisted = this.db.query<MetricBatchRow, [number]>(`
      SELECT payload FROM metric_batches
      WHERE end_ms >= ?
      ORDER BY start_ms, id
    `).all(sinceMs)
      .flatMap(row => parseMetricBatch(row.payload))
      .filter(aggregate =>
        aggregate.timestampMs >= sinceMs
        && (!accountId || aggregate.accountId === accountId))
      .map<DaemonMetricEvent>(aggregate => {
        const event: DaemonMetricEvent = {
        timestamp: aggregate.timestamp,
        processingMode: aggregate.processingMode,
        modelId: aggregate.modelId,
        provider: aggregate.provider,
        inputTokens: aggregate.inputTokens,
        cachedInputTokens: aggregate.cachedInputTokens,
        cacheWriteTokens: aggregate.cacheWriteTokens,
        outputTokens: aggregate.outputTokens,
        durationMs: aggregate.durationMs,
        error: aggregate.errors > 0,
        cancelled: aggregate.cancellations > 0,
        };
        if (aggregate.accountId) event.accountId = aggregate.accountId;
        return event;
      });
    const pending = this.pendingEvents.filter(event =>
      Date.parse(event.timestamp) >= sinceMs
      && (!accountId || event.accountId === accountId));
    return [...rows.map(rowToEvent), ...persisted, ...pending]
      .toSorted((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
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
    const persisted = this.db.query<MetricBatchRow, [number, number]>(`
      SELECT payload FROM metric_batches
      WHERE start_ms < ? AND end_ms >= ?
      ORDER BY start_ms, id
    `).all(endMs, startMs)
      .flatMap(row => parseMetricBatch(row.payload));
    const pending = aggregateMetricEvents(this.pendingEvents);
    for (const aggregate of [...persisted, ...pending]) {
      if (
        aggregate.timestampMs < startMs
        || aggregate.timestampMs >= endMs
        || (accountId && aggregate.accountId !== accountId)
      ) continue;
      const index = Math.floor((aggregate.timestampMs - startMs) / bucketMs);
      const bucket = buckets[index];
      if (bucket) addAggregate(bucket, aggregate);
    }
    return buckets;
  }

  secondwindLifetime(): SecondwindLifetimeMetrics {
    const row = this.db.query<{
      requests: number;
      blocks_rewritten: number;
      input_tokens_considered: number;
      tokens_reduced: number;
      estimated_token_requests: number;
      estimated_savings_usd: number;
      observed_input_tokens: number;
      saved_input_tokens: number;
      saved_cached_input_tokens: number;
      saved_cache_write_tokens: number;
      estimated_input_savings_usd: number;
      estimated_cache_savings_usd: number;
      estimated_output_savings_usd: number;
    }, []>(`
      SELECT requests, blocks_rewritten, input_tokens_considered, tokens_reduced,
        estimated_token_requests, estimated_savings_usd, observed_input_tokens,
        saved_input_tokens, saved_cached_input_tokens, saved_cache_write_tokens,
        estimated_input_savings_usd, estimated_cache_savings_usd,
        estimated_output_savings_usd
      FROM secondwind_lifetime
      WHERE singleton = 1
    `).get();
    const pending = sumSecondwindSavings(this.pendingSecondwind);
    return {
      requests: safeInteger(row?.requests) + pending.requests,
      blocksRewritten: safeInteger(row?.blocks_rewritten) + pending.blocksRewritten,
      inputTokensConsidered:
        safeInteger(row?.input_tokens_considered) + pending.inputTokensConsidered,
      tokensReduced: safeInteger(row?.tokens_reduced) + pending.tokensReduced,
      estimatedTokenRequests:
        safeInteger(row?.estimated_token_requests) + pending.estimatedTokenRequests,
      estimatedSavingsUsd: isNumber(row?.estimated_savings_usd)
        && Number.isFinite(row.estimated_savings_usd)
        ? Math.max(0, row.estimated_savings_usd) + pending.estimatedSavingsUsd
        : pending.estimatedSavingsUsd,
      observedInputTokens:
        safeInteger(row?.observed_input_tokens) + pending.observedInputTokens,
      savedInputTokens: safeInteger(row?.saved_input_tokens) + pending.savedInputTokens,
      savedCachedInputTokens:
        safeInteger(row?.saved_cached_input_tokens) + pending.savedCachedInputTokens,
      savedCacheWriteTokens:
        safeInteger(row?.saved_cache_write_tokens) + pending.savedCacheWriteTokens,
      estimatedInputSavingsUsd:
        Math.max(0, row?.estimated_input_savings_usd ?? 0)
        + pending.estimatedInputSavingsUsd,
      estimatedCacheSavingsUsd:
        Math.max(0, row?.estimated_cache_savings_usd ?? 0)
        + pending.estimatedCacheSavingsUsd,
      estimatedOutputSavingsUsd:
        Math.max(0, row?.estimated_output_savings_usd ?? 0)
        + pending.estimatedOutputSavingsUsd,
    };
  }

  appendSecondwindSavings(event: SecondwindSavingsInput): void {
    try {
      this.pendingSecondwind.push(event);
      this.scheduleFlush();
    } catch {
      // Metrics must never alter inference behavior.
    }
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flush();
    this.db.close();
  }

  private scheduleFlush(): void {
    if (this.pendingEvents.length + this.pendingSecondwind.length >= METRICS_FLUSH_BATCH_SIZE) {
      this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, METRICS_FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pendingEvents.length === 0 && this.pendingSecondwind.length === 0) return;
    const events = this.pendingEvents.splice(0);
    const secondwind = this.pendingSecondwind.splice(0);
    try {
      const aggregates = aggregateMetricEvents(events);
      const secondwindTotal = sumSecondwindSavings(secondwind);
      const persist = this.db.transaction(() => {
        if (aggregates.length > 0) {
          const startMs = aggregates[0]!.timestampMs;
          const endMs = aggregates[aggregates.length - 1]!.timestampMs + ONE_MINUTE_MS;
          this.db.query(`
            INSERT INTO metric_batches (start_ms, end_ms, payload)
            VALUES (?, ?, ?)
          `).run(startMs, endMs, JSON.stringify(aggregates));
        }
        if (secondwind.length > 0) {
          this.updateSecondwindSavings(secondwindTotal);
        }
      });
      persist.immediate();
      this.prune(this.now());
    } catch {
      // Metrics must never alter inference behavior.
    }
  }

  private updateSecondwindSavings(event: SecondwindSavingsEvent): void {
    this.db.query(`
      UPDATE secondwind_lifetime
      SET requests = requests + ?,
        blocks_rewritten = blocks_rewritten + ?,
        input_tokens_considered = input_tokens_considered + ?,
        tokens_reduced = tokens_reduced + ?,
        estimated_token_requests = estimated_token_requests + ?,
        estimated_savings_usd = estimated_savings_usd + ?,
        observed_input_tokens = observed_input_tokens + ?,
        saved_input_tokens = saved_input_tokens + ?,
        saved_cached_input_tokens = saved_cached_input_tokens + ?,
        saved_cache_write_tokens = saved_cache_write_tokens + ?,
        estimated_input_savings_usd = estimated_input_savings_usd + ?,
        estimated_cache_savings_usd = estimated_cache_savings_usd + ?,
        estimated_output_savings_usd = estimated_output_savings_usd + ?
      WHERE singleton = 1
    `).run(
      event.requests,
      event.blocksRewritten,
      event.inputTokensConsidered,
      event.tokensReduced,
      event.estimatedTokenRequests,
      event.estimatedSavingsUsd,
      safeInteger(event.observedInputTokens),
      safeInteger(event.savedInputTokens),
      safeInteger(event.savedCachedInputTokens),
      safeInteger(event.savedCacheWriteTokens),
      Math.max(0, event.estimatedInputSavingsUsd),
      Math.max(0, event.estimatedCacheSavingsUsd),
      Math.max(0, event.estimatedOutputSavingsUsd),
    );
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
    this.db.query('DELETE FROM metric_batches WHERE end_ms < ?')
      .run(now - METRICS_RETENTION_MS);
    this.lastPrunedAt = now;
  }
}
