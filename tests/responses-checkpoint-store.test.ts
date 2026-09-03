import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  deleteStoredResponsesCheckpoint,
  loadStoredResponsesCheckpoints,
  saveStoredResponsesCheckpoint,
  type StoredResponsesCheckpoint,
} from '../src/oauth/responses-checkpoint-store.js';

function checkpoint(
  checkpointKey: string,
  lineageKey = randomUUID(),
  lastUsedAt = Date.now(),
): StoredResponsesCheckpoint {
  return {
    checkpointKey,
    lineageKey,
    requestInputHashes: ['request-hash'],
    requestInputKinds: ['user'],
    expectedAssistantHashes: ['assistant-hash'],
    expectedAssistantKinds: ['assistant'],
    queuedEventHashes: ['queued-event-hash'],
    compactedInput: [{ type: 'compaction', encrypted_content: 'opaque-state' }],
    lastInputTokens: 42,
    postCompactionInputTokens: 40,
    nextCompactionInputTokens: 16_040,
    lastUsedAt,
  };
}

function storeDirectory(label: string): string {
  mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
  return mkdtempSync(join(process.env.CLODEX_HOME!, `${label}-`));
}

describe('Responses checkpoint store', () => {
  it('round-trips a checkpoint with owner-only permissions', () => {
    const directory = storeDirectory('checkpoint-roundtrip');
    const value = checkpoint('a'.repeat(64));
    expect(saveStoredResponsesCheckpoint(directory, value, 8, 32)).toBe(true);

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
    expect(loadStoredResponsesCheckpoints(directory, value.lastUsedAt + 1, 10_000))
      .toEqual([value]);
  });

  it('round-trips compacted state larger than the former 8 MiB limit', () => {
    const directory = storeDirectory('checkpoint-large');
    const value = checkpoint('9'.repeat(64));
    value.compactedInput = [{
      type: 'function_call_output',
      call_id: 'large-tool-result',
      output: 'x'.repeat(9 * 1024 * 1024),
    }];

    expect(saveStoredResponsesCheckpoint(directory, value, 16, 256)).toBe(true);
    const loaded = loadStoredResponsesCheckpoints(directory, value.lastUsedAt + 1, 10_000);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.compactedInput).toEqual(value.compactedInput);
  });

  it('drops expired, corrupt, and identity-invalid checkpoint files', () => {
    const directory = storeDirectory('checkpoint-validation');
    const expired = checkpoint('b'.repeat(64), randomUUID(), 0);
    saveStoredResponsesCheckpoint(directory, expired, 8, 32);
    const corruptName = `${'c'.repeat(64)}-${randomUUID()}.json`;
    const invalidName = `${'d'.repeat(64)}-${randomUUID()}.json`;
    writeFileSync(join(directory, corruptName), '{', { mode: 0o600 });
    writeFileSync(join(directory, invalidName), JSON.stringify({
      ...checkpoint('c'.repeat(64)),
      lineageKey: '../../outside',
    }), { mode: 0o600 });
    writeFileSync(join(directory, 'unrelated.json'), '{"keep":true}', { mode: 0o600 });

    expect(loadStoredResponsesCheckpoints(directory, 1_001, 1_000)).toEqual([]);
    expect(readdirSync(directory)).toEqual(['unrelated.json']);
  });

  it('rejects symlinked stores without modifying their targets', () => {
    const target = storeDirectory('checkpoint-symlink-target');
    const value = checkpoint('c'.repeat(64));
    saveStoredResponsesCheckpoint(target, value, 8, 32);
    writeFileSync(join(target, 'unrelated.json'), '{"keep":true}', { mode: 0o600 });
    const link = join(process.env.CLODEX_HOME!, 'checkpoint-store-link');
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, 'dir');

    expect(() => loadStoredResponsesCheckpoints(link, value.lastUsedAt + 1, 10_000))
      .toThrow('must be a real directory');
    expect(() => saveStoredResponsesCheckpoint(link, value, 8, 32))
      .toThrow('must be a real directory');
    deleteStoredResponsesCheckpoint(link, value.checkpointKey, value.lineageKey);
    expect(readdirSync(target)).toContain('unrelated.json');
    expect(loadStoredResponsesCheckpoints(target, value.lastUsedAt + 1, 10_000))
      .toEqual([value]);
  });

  it('bounds durable entries per partition and globally', () => {
    const directory = storeDirectory('checkpoint-caps');
    for (let index = 0; index < 6; index += 1) {
      saveStoredResponsesCheckpoint(
        directory,
        checkpoint('d'.repeat(64), randomUUID(), index),
        3,
        5,
      );
    }
    expect(readdirSync(directory)).toHaveLength(3);

    for (const key of ['e', 'f', '0', '1']) {
      saveStoredResponsesCheckpoint(
        directory,
        checkpoint(key.repeat(64)),
        3,
        5,
      );
    }
    expect(readdirSync(directory)).toHaveLength(5);
    for (const name of readdirSync(directory)) {
      expect(readFileSync(join(directory, name), 'utf8')).toContain('"queuedEventHashes"');
    }
  });
});
