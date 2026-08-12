import { describe, expect, it } from 'bun:test';
import {
  AgentStreamTransaction,
  commitProviderStreamLive,
  isResponseStreamRetryEligible,
  responseStreamRetryDelayMs,
  waitForResponseStreamRetry,
} from '../src/agent-stream-transaction.js';

describe('AgentStreamTransaction', () => {
  it('discards a failed attempt and commits only the completed replay', () => {
    const committed: string[] = [];
    const transaction = new AgentStreamTransaction({
      enabled: true,
      commitChunk: chunk => committed.push(chunk),
    });

    transaction.write('failed text');
    transaction.write('failed tool call');
    expect(committed).toEqual([]);
    expect(transaction.discard()).toBeGreaterThan(0);

    transaction.write('successful replay');
    transaction.commit();
    expect(committed).toEqual(['successful replay']);
    expect(transaction.replaySafe).toBe(false);
  });

  it('falls back to ordered passthrough after its memory ceiling', () => {
    const committed: string[] = [];
    const overflows: number[] = [];
    const transaction = new AgentStreamTransaction({
      enabled: true,
      maxBufferBytes: 5,
      commitChunk: chunk => committed.push(chunk),
      onBufferLimitExceeded: bytes => overflows.push(bytes),
    });

    transaction.write('abc');
    transaction.write('def');
    transaction.write('ghi');

    expect(overflows).toEqual([6]);
    expect(committed).toEqual(['abc', 'def', 'ghi']);
    expect(transaction.discard()).toBeUndefined();
  });

  it('keeps ordinary streams in immediate passthrough mode', () => {
    const committed: string[] = [];
    const transaction = new AgentStreamTransaction({
      enabled: false,
      commitChunk: chunk => committed.push(chunk),
    });

    transaction.write('main-agent output');

    expect(committed).toEqual(['main-agent output']);
    expect(transaction.replaySafe).toBe(false);
  });
});

describe('response stream retry timing', () => {
  it('commits SuperGrok live only after semantic output starts', () => {
    const committed: string[] = [];
    const transaction = new AgentStreamTransaction({
      enabled: true,
      commitChunk: chunk => committed.push(chunk),
    });
    transaction.write('buffered');

    expect(commitProviderStreamLive(transaction, 'xai-oauth', 'start')).toBe(false);
    expect(commitProviderStreamLive(transaction, 'openai-oauth', 'reasoning-start')).toBe(false);
    expect(commitProviderStreamLive(transaction, 'xai-oauth', 'tool-input-start')).toBe(false);
    expect(committed).toEqual([]);

    expect(commitProviderStreamLive(transaction, 'xai-oauth', 'reasoning-start')).toBe(true);
    expect(committed).toEqual(['buffered']);
    expect(transaction.replaySafe).toBe(false);
    transaction.write('live');
    expect(committed).toEqual(['buffered', 'live']);
    expect(commitProviderStreamLive(transaction, 'xai-oauth', 'text-delta')).toBe(false);
  });

  it('uses bounded exponential delays and honors retry-after', () => {
    expect(responseStreamRetryDelayMs(1)).toBe(250);
    expect(responseStreamRetryDelayMs(2)).toBe(500);
    expect(responseStreamRetryDelayMs(99)).toBe(500);
    expect(responseStreamRetryDelayMs(1, 7)).toBe(7_000);
  });

  it('does not hold Claude open for an excessive retry-after delay', () => {
    expect(isResponseStreamRetryEligible(true, 15)).toBe(true);
    expect(isResponseStreamRetryEligible(true, 16)).toBe(false);
    expect(isResponseStreamRetryEligible(false, 1)).toBe(false);
  });

  it('cancels retry backoff immediately when Claude disconnects', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const waiting = waitForResponseStreamRetry(10_000, controller.signal);
    controller.abort();

    expect(await waiting).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
