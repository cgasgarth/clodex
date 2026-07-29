import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonMetricsStore } from '../src/daemon/metrics.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DaemonMetricsStore', () => {
  it('persists and buckets privacy-minimal token usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const store = new DaemonMetricsStore(join(root, 'metrics.jsonl'));
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    store.append({
      timestamp,
      requestId: 'r1',
      sessionHash: 'hashed',
      modelId: 'sol',
      provider: 'openai-oauth',
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteTokens: 5,
      outputTokens: 10,
      durationMs: 1_000,
      error: false,
      cancelled: false,
    });
    store.append({
      timestamp,
      requestId: 'r2',
      sessionHash: 'hashed',
      modelId: 'sol',
      provider: 'openai-oauth',
      inputTokens: 50,
      cachedInputTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 3,
      error: false,
      cancelled: true,
    });
    expect(store.buckets().find(bucket => bucket.requests === 2)).toEqual(
      expect.objectContaining({
        inputTokens: 150,
        cachedInputTokens: 120,
        cacheWriteTokens: 5,
        outputTokens: 13,
        errors: 0,
        cancellations: 1,
      }),
    );
  });

  it('rolls over at the size cap and serves buckets from memory', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-metrics-'));
    roots.push(root);
    const path = join(root, 'metrics.jsonl');
    const store = new DaemonMetricsStore(path, { maxFileBytes: 250 });
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    for (let index = 0; index < 6; index += 1) {
      store.append({
        timestamp,
        requestId: `request-${index}`,
        modelId: 'sol',
        provider: 'openai-oauth',
        inputTokens: 10,
        cachedInputTokens: 8,
        cacheWriteTokens: 0,
        outputTokens: 1,
        error: false,
      });
    }
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0);
    expect(store.buckets().find(bucket => bucket.requests === 6))
      .toEqual(expect.objectContaining({ inputTokens: 60, cachedInputTokens: 48 }));
  });
});
