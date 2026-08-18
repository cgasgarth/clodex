import { describe, expect, it } from 'bun:test';
import {
  SecondwindWorkerPool,
  secondwindWorkerCount,
  secondwindWorkerShard,
} from '../src/daemon/secondwind-worker-pool.js';
import type { JsonObject } from './test-helpers.js';

const workerUrl = new URL('./fixtures/secondwind-pool-worker.ts', import.meta.url);

function decode(body: Uint8Array): { workerId: string } {
  // SAFETY: The test fixture defines the asserted runtime shape.
  return JSON.parse(new TextDecoder().decode(body)) as { workerId: string };
}

function encode(request: JsonObject): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

function keysOnDistinctShards(count: number): [string, string] {
  const first = 'session-0';
  const firstShard = secondwindWorkerShard(first, count);
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = `session-${index}`;
    if (secondwindWorkerShard(candidate, count) !== firstShard) return [first, candidate];
  }
  throw new Error('Unable to find keys on distinct worker shards');
}

describe('Secondwind worker pool', () => {
  it('uses up to eight workers based on machine parallelism', () => {
    expect(secondwindWorkerCount(2)).toBe(2);
    expect(secondwindWorkerCount(6)).toBe(4);
    expect(secondwindWorkerCount(18)).toBe(8);
    expect(secondwindWorkerCount(64)).toBe(8);
  });

  it('reuses native conversation state with stable bytes across repeated requests', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 1 });
    const records = Array.from({ length: 400 }, (_, index) => ({
      id: index,
      path: `file-${index}.txt`,
      state: index % 2 ? 'open' : 'closed',
      owner: `team-${index % 5}`,
    }));
    const request = {
      model: 'sol',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: JSON.stringify(records),
        }],
      }],
    };
    try {
      const first = await pool.rewrite('conversation-a', encode(request));
      const second = await pool.rewrite('conversation-a', encode(request));
      expect(first.body).toEqual(second.body);
      expect(first.body.byteLength).toBeLessThan(JSON.stringify(request).length);
      expect(first.stats?.blocks_first_seen).toBe(1);
      expect(second.stats?.blocks_first_seen).toBe(0);
      expect(pool.snapshot()).toMatchObject({
        sessions: 1,
        sessionHits: 1,
        sessionMisses: 1,
      });
    } finally {
      pool.close();
    }
  });

  it('processes only newly appended blocks as a conversation grows', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 1 });
    const firstContent = JSON.stringify(Array.from({ length: 400 }, (_, index) => ({
      id: index,
      path: `src/first-${index}.ts`,
      diagnostic: `first-diagnostic-${index}`,
    })));
    const secondContent = JSON.stringify(Array.from({ length: 400 }, (_, index) => ({
      id: index,
      path: `src/second-${index}.ts`,
      diagnostic: `second-diagnostic-${index}`,
    })));
    const request = (includeSecond: boolean) => ({
      model: 'sol',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: firstContent,
          },
          ...(includeSecond
            ? [{ type: 'tool_result', tool_use_id: 'tool-2', content: secondContent }]
            : []),
        ],
      }],
    });
    try {
      const first = await pool.rewrite('growing-conversation', encode(request(false)));
      const grown = await pool.rewrite('growing-conversation', encode(request(true)));
      const resend = await pool.rewrite('growing-conversation', encode(request(true)));

      expect(first.stats?.blocks_first_seen).toBe(1);
      expect(grown.stats?.blocks_first_seen).toBe(1);
      expect(resend.stats?.blocks_first_seen).toBe(0);
      expect(grown.stats?.blocks_rewritten).toBe(2);
      expect(grown.body).toEqual(resend.body);
    } finally {
      pool.close();
    }
  });

  it('does not detach or mutate the caller-owned Bun Buffer', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 1, workerUrl });
    const body = Buffer.from(JSON.stringify({ unchanged: true }));
    const original = Buffer.from(body);
    try {
      await pool.rewrite('buffer-owner', body);
      expect(body.byteLength).toBe(original.byteLength);
      expect(body).toEqual(original);
    } finally {
      pool.close();
    }
  });

  it('keeps requests without a conversation key ephemeral', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 1, workerUrl });
    try {
      await pool.rewrite(undefined, encode({ request: 1 }));
      await pool.rewrite(undefined, encode({ request: 2 }));
      expect(pool.snapshot()).toMatchObject({
        sessions: 0,
        sessionHits: 0,
        sessionMisses: 0,
      });
    } finally {
      pool.close();
    }
  });

  it('keeps the daemon responsive and runs distinct conversation shards concurrently', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 2, workerUrl });
    const [firstKey, secondKey] = keysOnDistinctShards(2);
    let heartbeat = 0;
    const timer = setInterval(() => {
      heartbeat += 1;
    }, 10);
    const startedAt = performance.now();
    try {
      const results = await Promise.all([
        pool.rewrite(firstKey, encode({ delayMs: 250 })),
        pool.rewrite(secondKey, encode({ delayMs: 250 })),
      ]);
      expect(decode(results[0]!.body).workerId).not.toBe(decode(results[1]!.body).workerId);
    } finally {
      clearInterval(timer);
      pool.close();
    }

    expect(performance.now() - startedAt).toBeLessThan(450);
    expect(heartbeat).toBeGreaterThan(5);
  });

  it('pins one conversation to one worker so native session state remains reusable', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 2, workerUrl });
    const startedAt = performance.now();
    try {
      const results = await Promise.all([
        pool.rewrite('shared-session', encode({ delayMs: 175 })),
        pool.rewrite('shared-session', encode({ delayMs: 175 })),
      ]);
      expect(decode(results[0]!.body).workerId).toBe(decode(results[1]!.body).workerId);
      expect(pool.snapshot()).toMatchObject({ sessionHits: 1, sessionMisses: 1 });
    } finally {
      pool.close();
    }

    expect(performance.now() - startedAt).toBeGreaterThan(300);
  });

  it('periodically recycles a worker so allocator and conversation state are released', async () => {
    const pool = new SecondwindWorkerPool({
      workerCount: 1,
      workerUrl,
      recycleAfterRequests: 1,
      recycleAfterRssBytes: Number.MAX_SAFE_INTEGER,
    });
    try {
      const first = decode((await pool.rewrite('recycled-session', encode({}))).body);
      const second = decode((await pool.rewrite('recycled-session', encode({}))).body);
      expect(second.workerId).not.toBe(first.workerId);
      expect(pool.snapshot()).toMatchObject({ sessionHits: 0, sessionMisses: 2 });
    } finally {
      pool.close();
    }
  });

  it('recycles a process after its resident-memory budget', async () => {
    const pool = new SecondwindWorkerPool({
      workerCount: 1,
      workerUrl,
      recycleAfterRequests: Number.MAX_SAFE_INTEGER,
      recycleAfterRssBytes: 1,
    });
    try {
      const first = decode((await pool.rewrite('rss-session', encode({ rssBytes: 2 }))).body);
      const second = decode((await pool.rewrite('rss-session', encode({ rssBytes: 2 }))).body);
      expect(second.workerId).not.toBe(first.workerId);
      expect(pool.snapshot()).toMatchObject({
        configured: 1,
        running: 0,
        pending: 0,
        recycled: 2,
        failures: 0,
      });
      expect(pool.snapshot().processedBytes).toBeGreaterThan(0);
    } finally {
      pool.close();
    }
  });

  it('rejects work from a crashed process and lazily recovers the slot', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 1, workerUrl });
    try {
      await expect(pool.rewrite('crash-session', encode({ exitCode: 13 })))
        .rejects.toThrow('Secondwind process failed');
      const recovered = decode((await pool.rewrite(
        'crash-session',
        encode({ recovered: true }),
      )).body);
      expect(recovered.workerId).toBeString();
      expect(pool.snapshot().failures).toBe(1);
    } finally {
      pool.close();
    }
  });
});
