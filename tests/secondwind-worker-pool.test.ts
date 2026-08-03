import { describe, expect, it } from 'bun:test';
import {
  SecondwindWorkerPool,
  secondwindWorkerCount,
} from '../src/daemon/secondwind-worker-pool.js';

const workerUrl = new URL('./fixtures/secondwind-pool-worker.ts', import.meta.url);

function decode(body: Uint8Array): { workerId: string } {
  return JSON.parse(new TextDecoder().decode(body)) as { workerId: string };
}

function encode(request: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

describe('Secondwind worker pool', () => {
  it('uses up to eight workers based on machine parallelism', () => {
    expect(secondwindWorkerCount(2)).toBe(2);
    expect(secondwindWorkerCount(6)).toBe(4);
    expect(secondwindWorkerCount(18)).toBe(8);
    expect(secondwindWorkerCount(64)).toBe(8);
  });

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
      const first = await pool.rewrite(encode(request));
      const second = await pool.rewrite(encode(request));
      expect(first.body).toEqual(second.body);
      expect(first.body.byteLength).toBeLessThan(JSON.stringify(request).length);
    } finally {
      pool.close();
    }
  });

  it('does not detach or mutate the caller-owned Bun Buffer', async () => {
    const pool = new SecondwindWorkerPool({ workerCount: 1, workerUrl });
    const body = Buffer.from(JSON.stringify({ unchanged: true }));
    const original = Buffer.from(body);
    try {
      await pool.rewrite(body);
      expect(body.byteLength).toBe(original.byteLength);
      expect(body).toEqual(original);
    } finally {
      pool.close();
    }
  });

  it('keeps the daemon responsive and randomly distributes concurrent rewrites', async () => {
    const selections = [0, 0.99];
    const pool = new SecondwindWorkerPool({
      workerCount: 2,
      workerUrl,
      random: () => selections.shift() ?? 0,
    });
    let heartbeat = 0;
    const timer = setInterval(() => {
      heartbeat += 1;
    }, 10);
    const startedAt = performance.now();
    try {
      const results = await Promise.all([
        pool.rewrite(encode({ delayMs: 250 })),
        pool.rewrite(encode({ delayMs: 250 })),
      ]);
      expect(decode(results[0]!.body).workerId).not.toBe(decode(results[1]!.body).workerId);
    } finally {
      clearInterval(timer);
      pool.close();
    }

    expect(performance.now() - startedAt).toBeLessThan(450);
    expect(heartbeat).toBeGreaterThan(5);
  });

  it('does not pin concurrent requests from one logical session to one worker', async () => {
    const selections = [0, 0.99];
    const pool = new SecondwindWorkerPool({
      workerCount: 2,
      workerUrl,
      random: () => selections.shift() ?? 0,
    });
    const startedAt = performance.now();
    try {
      await Promise.all([
        pool.rewrite(encode({ delayMs: 175 })),
        pool.rewrite(encode({ delayMs: 175 })),
      ]);
    } finally {
      pool.close();
    }

    expect(performance.now() - startedAt).toBeLessThan(320);
  });

  it('periodically recycles a stateless worker so allocator state is released', async () => {
    const pool = new SecondwindWorkerPool({
      workerCount: 1,
      workerUrl,
      recycleAfterRequests: 1,
    });
    try {
      const first = decode((await pool.rewrite(encode({}))).body);
      const second = decode((await pool.rewrite(encode({}))).body);
      expect(second.workerId).not.toBe(first.workerId);
    } finally {
      pool.close();
    }
  });
});
