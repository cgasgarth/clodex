import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteResponsesCheckpointStore } from '../src/oauth/responses-checkpoint-store.js';
import {
  RESPONSES_COMPACTION_CHECKPOINT_TTL_MS,
  type CompactionCheckpoint,
} from '../src/oauth/responses-websocket/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'clodex-checkpoints-'));
  roots.push(root);
  return join(root, 'checkpoints.sqlite');
}

function checkpoint(
  key: string,
  lastUsedAt: number,
  label: string,
): CompactionCheckpoint {
  return {
    connectionId: 1,
    lineageId: 2,
    lineageKey: `lineage-${label}`,
    key,
    requestInput: [],
    expectedAssistant: [],
    requestInputHashes: [`request-${label}`],
    requestInputKinds: ['user'],
    expectedAssistantHashes: [`assistant-${label}`],
    expectedAssistantKinds: ['assistant'],
    queuedEventHashes: [],
    compactedInput: [{ type: 'compaction', encrypted_content: `opaque-${label}` }],
    lastInputTokens: 341_372,
    postCompactionInputTokens: 40_000,
    nextCompactionInputTokens: 90_000,
    promptFieldHashes: { model: 'model-hash' },
    lastUsedAt,
    ttlMs: RESPONSES_COMPACTION_CHECKPOINT_TTL_MS,
  };
}

describe('SqliteResponsesCheckpointStore', () => {
  it('round-trips restart state in an owner-only local database', () => {
    const path = storePath();
    const store = new SqliteResponsesCheckpointStore(path);
    const value = checkpoint('a'.repeat(64), 1_000, 'current');

    expect(store.save(value)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.close();

    const reopened = new SqliteResponsesCheckpointStore(path);
    expect(reopened.load(value.key, 1_001)).toEqual(expect.objectContaining({
      key: value.key,
      lineageKey: value.lineageKey,
      compactedInput: value.compactedInput,
      lastInputTokens: 341_372,
      lastUsedAt: 1_001,
    }));
    reopened.close();
  });

  it('replaces only the prior durable checkpoint for the same session', () => {
    const store = new SqliteResponsesCheckpointStore(storePath());
    const key = 'b'.repeat(64);
    const otherKey = 'd'.repeat(64);
    expect(store.save(checkpoint(key, 1_000, 'old'))).toBe(true);
    expect(store.save(checkpoint(otherKey, 1_200, 'other'))).toBe(true);
    expect(store.save(checkpoint(key, 2_000, 'new'))).toBe(true);
    expect(store.save(checkpoint(key, 1_500, 'stale'))).toBe(false);

    expect(store.size()).toBe(2);
    expect(store.load(key, 3_000)).toEqual(expect.objectContaining({
      lineageKey: 'lineage-new',
      compactedInput: [{ type: 'compaction', encrypted_content: 'opaque-new' }],
      lastUsedAt: 3_000,
    }));
    expect(store.load(otherKey, 3_000)).toEqual(expect.objectContaining({
      lineageKey: 'lineage-other',
    }));
    store.close();
  });

  it('deletes an invalid local record instead of restoring it', () => {
    const path = storePath();
    const key = 'c'.repeat(64);
    const store = new SqliteResponsesCheckpointStore(path);
    store.save(checkpoint(key, 1_000, 'valid'));
    store.close();
    const editor = new Database(path, { strict: true });
    editor.query('UPDATE checkpoints SET payload = ? WHERE checkpoint_key = ?').run('{', key);
    editor.close();

    const reopened = new SqliteResponsesCheckpointStore(path);
    expect(reopened.load(key, 2_000)).toBeUndefined();
    expect(reopened.size()).toBe(0);
    reopened.close();
  });
});
