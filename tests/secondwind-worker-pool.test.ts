import { describe, expect, it } from 'bun:test';
import {
  SecondwindWorkerPool,
  secondwindWorkerShard,
} from '../src/daemon/secondwind-worker-pool.js';

const workerUrl = new URL('./fixtures/secondwind-pool-worker.ts', import.meta.url);

function keysOnDifferentShards(): [string, string] {
  for (let left = 0; left < 100; left += 1) {
    for (let right = left + 1; right < 100; right += 1) {
      const leftKey = `session-${left}`;
      const rightKey = `session-${right}`;
      if (secondwindWorkerShard(leftKey, 2) !== secondwindWorkerShard(rightKey, 2)) {
        return [leftKey, rightKey];
      }
    }
  }
  throw new Error('Could not find keys on different worker shards');
}

function decode(body: Uint8Array): { workerId: string } {
  return JSON.parse(new TextDecoder().decode(body)) as { workerId: string };
}

describe('Secondwind worker pool', () => {
  it('runs native stateless rewrites with stable bytes across repeated requests', async () => {
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
      const first = await pool.rewrite('native-session', request);
      const second = await pool.rewrite('native-session', request);
      expect(first.body).toEqual(second.body);
      expect(first.body.byteLength).toBeLessThan(JSON.stringify(request).length);
    } finally {
      pool.close();
    }
  });

  it('keeps the daemon event loop responsive and runs separate agents in parallel', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 2, workerUrl });
    const [leftKey, rightKey] = keysOnDifferentShards();
    let heartbeat = 0;
    const timer = setInterval(() => {
      heartbeat += 1;
    }, 10);
    const startedAt = performance.now();
    try {
      await Promise.all([
        pool.rewrite(leftKey, { delayMs: 250 }),
        pool.rewrite(rightKey, { delayMs: 250 }),
      ]);
    } finally {
      clearInterval(timer);
      pool.close();
    }

    expect(performance.now() - startedAt).toBeLessThan(450);
    expect(heartbeat).toBeGreaterThan(5);
  });

  it('serializes rewrites for the same logical agent session', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 2, workerUrl });
    const startedAt = performance.now();
    try {
      await Promise.all([
        pool.rewrite('same-session', { delayMs: 175 }),
        pool.rewrite('same-session', { delayMs: 175 }),
      ]);
    } finally {
      pool.close();
    }

    expect(performance.now() - startedAt).toBeGreaterThan(320);
  });

  it('periodically recycles a stateless worker so allocator state is released', async () => {
    const pool = new SecondwindWorkerPool({
      workerCount: 1,
      workerUrl,
      recycleAfterRequests: 1,
    });
    try {
      const first = decode((await pool.rewrite('finished-session', {})).body);
      const second = decode((await pool.rewrite('new-session', {})).body);
      expect(second.workerId).not.toBe(first.workerId);
    } finally {
      pool.close();
    }
  });
});
