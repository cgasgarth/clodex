import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  checkpointEntries,
  hydrateCompactionCheckpoint,
  loadCompactionCheckpointStore,
  persistCompactionCheckpoint,
  resetResponsesWebSocketConnectionsForTests,
} from '../src/oauth/responses-websocket/state.js';
import type { HydratedCompactionCheckpoint } from '../src/oauth/responses-websocket/types.js';

const stores: string[] = [];

function storeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'clodex-checkpoint-state-'));
  stores.push(directory);
  return directory;
}

function checkpoint(
  directory: string,
  key: string,
  lastUsedAt: number,
): HydratedCompactionCheckpoint {
  return {
    connectionId: 0,
    lineageId: lastUsedAt,
    lineageKey: randomUUID(),
    key,
    requestInputHashes: [`request-${lastUsedAt}`],
    expectedAssistantHashes: [`assistant-${lastUsedAt}`],
    expectedAssistantKinds: ['assistant'],
    compactedInput: [{ type: 'compaction', encrypted_content: `state-${lastUsedAt}` }],
    lastUsedAt,
    ttlMs: 60_000,
    checkpointStoreDir: directory,
  };
}

afterEach(() => {
  resetResponsesWebSocketConnectionsForTests();
  for (const directory of stores.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Responses WebSocket checkpoint state', () => {
  it('bounds hot durable payloads while retaining all lineage metadata', () => {
    const directory = storeDirectory();
    const key = 'a'.repeat(64);
    for (let index = 1; index <= 10; index += 1) {
      expect(persistCompactionCheckpoint(checkpoint(directory, key, index), () => {})).toBe(true);
    }

    const entries = checkpointEntries(key);
    expect(entries).toHaveLength(10);
    expect(entries.filter(entry => entry.compactedInput !== undefined)).toHaveLength(8);
    const cold = entries.find(entry => entry.compactedInput === undefined);
    expect(cold).toBeDefined();
    expect(hydrateCompactionCheckpoint(cold!)?.compactedInput).toEqual([
      expect.objectContaining({ encrypted_content: expect.stringContaining('state-') }),
    ]);
  });

  it('indexes all durable lineages without retaining payloads and hydrates only a requested partition', () => {
    const directory = storeDirectory();
    const requestedKey = 'b'.repeat(64);
    const otherKey = 'c'.repeat(64);
    persistCompactionCheckpoint(checkpoint(directory, requestedKey, 10), () => {});
    persistCompactionCheckpoint(checkpoint(directory, otherKey, 20), () => {});
    resetResponsesWebSocketConnectionsForTests();

    loadCompactionCheckpointStore(directory, 30);
    expect(checkpointEntries()).toHaveLength(2);
    expect(checkpointEntries().every(entry => entry.compactedInput === undefined)).toBe(true);
    expect(checkpointEntries().every(entry => entry.requestInputHashes.length === 0)).toBe(true);

    loadCompactionCheckpointStore(directory, 31, requestedKey);
    expect(checkpointEntries(requestedKey)[0]?.requestInputHashes).toEqual(['request-10']);
    expect(checkpointEntries(requestedKey)[0]?.compactedInput).toBeUndefined();
    expect(checkpointEntries(otherKey)[0]?.requestInputHashes).toEqual([]);
    expect(hydrateCompactionCheckpoint(checkpointEntries(requestedKey)[0]!)?.compactedInput)
      .toEqual([{ type: 'compaction', encrypted_content: 'state-10' }]);
  });
});
