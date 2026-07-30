import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DaemonMetricsStore } from '../src/daemon/metrics.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DaemonMetricsStore', () => {
  it('persists, account-filters, buckets, and prices token usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const now = Date.now();
    const store = new DaemonMetricsStore(join(root, 'metrics.sqlite'), { now: () => now });
    const timestamp = new Date(now - 60_000).toISOString();
    store.append({
      timestamp,
      requestId: 'r1',
      sessionHash: 'hashed',
      accountId: 'account-a',
      processingMode: 'fast',
      modelId: 'sol',
      provider: 'openai-oauth',
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      cacheWriteTokens: 5_000,
      outputTokens: 10_000,
      durationMs: 1_000,
      error: false,
      cancelled: false,
    });
    store.append({
      timestamp,
      requestId: 'r2',
      accountId: 'account-b',
      modelId: 'luna',
      provider: 'openai-oauth',
      inputTokens: 50,
      cachedInputTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 3,
      error: false,
      cancelled: true,
    });
    const bucket = store.bucketsRange(
      now - 3_600_000,
      now,
      3_600_000,
      'account-a',
    ).find(item => item.requests === 1);
    expect(bucket).toEqual(expect.objectContaining({
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      cacheWriteTokens: 5_000,
      outputTokens: 10_000,
      errors: 0,
      cancellations: 0,
      pricedRequests: 1,
      unpricedRequests: 0,
      standardRequests: 0,
      fastRequests: 1,
    }));
    expect(bucket?.totalCost).toBeCloseTo(1.7425);
    expect(bucket?.fastCost).toBeCloseTo(1.7425);
    expect(bucket?.standardCost).toBe(0);
    expect(store.readSince(0, 'account-b')).toHaveLength(1);
    store.close();
  });

  it('migrates legacy JSONL rows as explicitly unattributed history', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const legacyPath = join(root, 'daemon-metrics.jsonl');
    const timestamp = new Date().toISOString();
    writeFileSync(legacyPath, `${JSON.stringify({
      timestamp,
      requestId: 'legacy',
      modelId: 'sol',
      provider: 'openai-oauth',
      inputTokens: 10,
      cachedInputTokens: 8,
      cacheWriteTokens: 0,
      outputTokens: 1,
      error: false,
    })}\n`);
    const store = new DaemonMetricsStore(join(root, 'metrics.sqlite'), { legacyPath });
    const migrated = store.readSince(0);
    expect(migrated).toEqual([expect.objectContaining({ requestId: 'legacy' })]);
    expect(migrated[0]?.processingMode).toBe('standard');
    expect('accountId' in migrated[0]!).toBe(false);
    expect(store.readSince(0, 'account-a')).toEqual([]);
    expect(existsSync(legacyPath)).toBe(false);
    store.close();
  });

  it('retains long history but prunes rows older than 400 days', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const now = Date.now();
    const store = new DaemonMetricsStore(join(root, 'metrics.sqlite'), { now: () => now });
    store.append({
      timestamp: new Date(now - 401 * 24 * 60 * 60_000).toISOString(),
      modelId: 'sol',
      provider: 'openai-oauth',
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      error: false,
    });
    expect(store.readSince(0)).toEqual([]);
    store.close();
  });

  it('persists lifetime Secondwind savings across store restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const path = join(root, 'metrics.sqlite');
    const first = new DaemonMetricsStore(path);
    first.appendSecondwindSavings({
      requests: 2,
      blocksRewritten: 7,
      inputTokensConsidered: 20_000,
      tokensReduced: 12_345,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0.042,
    });
    first.close();

    const reopened = new DaemonMetricsStore(path);
    expect(reopened.secondwindLifetime()).toEqual({
      requests: 2,
      blocksRewritten: 7,
      inputTokensConsidered: 20_000,
      tokensReduced: 12_345,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0.042,
    });
    reopened.appendSecondwindSavings({
      requests: 1,
      blocksRewritten: 2,
      inputTokensConsidered: 5_000,
      tokensReduced: 655,
      estimatedTokenRequests: 1,
      estimatedSavingsUsd: 0.008,
    });
    expect(reopened.secondwindLifetime()).toEqual({
      requests: 3,
      blocksRewritten: 9,
      inputTokensConsidered: 25_000,
      tokensReduced: 13_000,
      estimatedTokenRequests: 1,
      estimatedSavingsUsd: 0.05,
    });
    reopened.close();
  });

  it('keeps reads in memory and writes one aggregate row on shutdown', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const path = join(root, 'metrics.sqlite');
    const store = new DaemonMetricsStore(path);
    const timestamp = new Date().toISOString();
    for (const requestId of ['batch-1', 'batch-2']) {
      store.append({
        timestamp,
        requestId,
        modelId: 'sol',
        provider: 'openai-oauth',
        inputTokens: 10,
        cachedInputTokens: 5,
        cacheWriteTokens: 0,
        outputTokens: 1,
        error: false,
      });
    }
    store.appendSecondwindSavings({
      requests: 2,
      blocksRewritten: 3,
      inputTokensConsidered: 1_000,
      tokensReduced: 500,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0.002,
    });

    const observer = new Database(path, { readonly: true });
    expect(observer.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM metric_events',
    ).get()?.count).toBe(0);
    expect(store.readSince(0)).toHaveLength(2);
    expect(observer.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM metric_events',
    ).get()?.count).toBe(0);
    expect(observer.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM metric_batches',
    ).get()?.count).toBe(0);
    expect(store.secondwindLifetime()).toMatchObject({
      requests: 2,
      tokensReduced: 500,
    });
    store.close();
    expect(observer.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM metric_batches',
    ).get()?.count).toBe(1);
    const payload = observer.query<{ payload: string }, []>(
      'SELECT payload FROM metric_batches',
    ).get()?.payload;
    expect(JSON.parse(payload ?? '[]')).toEqual([
      expect.objectContaining({ requests: 2, inputTokens: 20, cachedInputTokens: 10 }),
    ]);
    observer.close();

    const reopened = new DaemonMetricsStore(path);
    const timestampMs = Date.parse(timestamp);
    expect(reopened.bucketsRange(timestampMs - 60_000, timestampMs + 60_000, 60_000)
      .reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(2);
    reopened.close();
  });

  it('flushes 1,000 pending records as one aggregate row', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const path = join(root, 'metrics.sqlite');
    const store = new DaemonMetricsStore(path);
    const timestamp = new Date().toISOString();
    for (let index = 0; index < 1_000; index += 1) {
      store.append({
        timestamp,
        requestId: `threshold-${index}`,
        modelId: 'sol',
        provider: 'openai-oauth',
        inputTokens: 10,
        cachedInputTokens: 5,
        cacheWriteTokens: 0,
        outputTokens: 1,
        error: false,
      });
    }

    const observer = new Database(path, { readonly: true });
    expect(observer.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM metric_batches',
    ).get()?.count).toBe(1);
    const payload = observer.query<{ payload: string }, []>(
      'SELECT payload FROM metric_batches',
    ).get()?.payload;
    expect(JSON.parse(payload ?? '[]')).toEqual([
      expect.objectContaining({
        requests: 1_000,
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
      }),
    ]);
    observer.close();
    store.close();
  });

  it('migrates schema-v1 databases to normal processing without losing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const path = join(root, 'metrics.sqlite');
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) VALUES (1);
      CREATE TABLE metric_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        request_id TEXT,
        session_hash TEXT,
        account_id TEXT,
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
    `);
    const timestamp = new Date().toISOString();
    legacy.query(`
      INSERT INTO metric_events (
        timestamp_ms, timestamp, model_id, provider, input_tokens,
        cached_input_tokens, cache_write_tokens, output_tokens, error, cancelled
      ) VALUES (?, ?, 'sol', 'openai-oauth', 10, 5, 0, 1, 0, 0)
    `).run(Date.parse(timestamp), timestamp);
    legacy.close();

    const store = new DaemonMetricsStore(path);
    expect(store.readSince(0)).toEqual([
      expect.objectContaining({
        processingMode: 'standard',
        inputTokens: 10,
        cachedInputTokens: 5,
      }),
    ]);
    store.close();
  });
});
