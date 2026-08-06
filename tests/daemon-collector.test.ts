import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonInferenceCollector } from '../src/daemon/collector.js';
import { DaemonMetricsStore } from '../src/daemon/metrics.js';
import type { InferenceTraceEvent } from '../src/trace-log.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DaemonInferenceCollector', () => {
  it('records one request after the outer response finishes, not the inner translation', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-collector-'));
    roots.push(root);
    const metrics = new DaemonMetricsStore(join(root, 'metrics.jsonl'));
    const collector = new DaemonInferenceCollector(metrics);
    const requestId = 'request-1';
    const sessionId = 'd2cc513d-542f-484f-ab4b-af9aae4ea924';
    const events: InferenceTraceEvent[] = [
      {
        kind: 'request',
        entry: {
          requestId,
          claudeSessionId: sessionId,
          accountId: 'account-a',
          processingMode: 'fast',
          modelId: 'gpt-5.6-sol',
          resolvedModelId: 'gpt-5.6-sol',
          provider: 'openai-oauth',
          route: 'translated',
        },
      },
      {
        kind: 'lifecycle',
        entry: {
          event: 'translation_completed',
          requestId,
          claudeSessionId: sessionId,
          modelId: 'gpt-5.6-sol',
          provider: 'openai-oauth',
          route: 'translated',
          durationMs: 900,
        },
      },
      {
        kind: 'lifecycle',
        entry: {
          event: 'response_usage',
          requestId,
          claudeSessionId: sessionId,
          modelId: 'gpt-5.6-sol',
          provider: 'openai-oauth',
          route: 'translated',
          usageStage: 'message_start',
          inputTokens: 120,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 5,
        },
      },
      {
        kind: 'lifecycle',
        entry: {
          event: 'response_usage',
          requestId,
          claudeSessionId: sessionId,
          modelId: 'gpt-5.6-sol',
          provider: 'openai-oauth',
          route: 'translated',
          usageStage: 'message_delta',
          outputTokens: 11,
        },
      },
      {
        kind: 'lifecycle',
        entry: {
          event: 'response_completed',
          requestId,
          claudeSessionId: sessionId,
          modelId: 'gpt-5.6-sol',
          provider: 'openai-oauth',
          route: 'translated',
          durationMs: 1_000,
        },
      },
    ];

    for (const event of events) collector.handle(event);

    expect(metrics.readSince(0)).toEqual([
      expect.objectContaining({
        requestId,
        accountId: 'account-a',
        processingMode: 'fast',
        inputTokens: 120,
        cachedInputTokens: 80,
        cacheWriteTokens: 5,
        outputTokens: 11,
        durationMs: 1_000,
        error: false,
      }),
    ]);
    expect(collector.sessions.snapshot()).toEqual([
      expect.objectContaining({
        activeRequests: 0,
        completedRequests: 1,
        cancelledRequests: 0,
        failedRequests: 0,
      }),
    ]);
  });

  it('tracks downstream cancellations separately from provider failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-collector-'));
    roots.push(root);
    const metrics = new DaemonMetricsStore(join(root, 'metrics.jsonl'));
    const collector = new DaemonInferenceCollector(metrics);
    const requestId = 'speculative-request';
    const sessionId = 'd2cc513d-542f-484f-ab4b-af9aae4ea924';
    collector.handle({
      kind: 'request',
      entry: {
        requestId,
        claudeSessionId: sessionId,
        modelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
      },
    });
    collector.handle({
      kind: 'lifecycle',
      entry: {
        event: 'response_client_disconnected',
        requestId,
        claudeSessionId: sessionId,
        modelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
        terminationSource: 'downstream_client',
      },
    });

    expect(metrics.readSince(0)).toEqual([
      expect.objectContaining({ error: false, cancelled: true }),
    ]);
    expect(collector.sessions.snapshot()).toEqual([
      expect.objectContaining({
        activeRequests: 0,
        completedRequests: 0,
        cancelledRequests: 1,
        failedRequests: 0,
      }),
    ]);
    expect(collector.recentDiagnostics()).toEqual([]);
  });

  it('accepts account attribution from the resolved inner adapter lifecycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-collector-'));
    roots.push(root);
    const metrics = new DaemonMetricsStore(join(root, 'metrics.sqlite'));
    const collector = new DaemonInferenceCollector(metrics);
    const requestId = 'outer-proxy-request';
    collector.handle({
      kind: 'request',
      entry: {
        requestId,
        modelId: 'sol',
        provider: 'openai-oauth',
        route: 'translated',
      },
    });
    collector.handle({
      kind: 'lifecycle',
      entry: {
        event: 'translation_completed',
        requestId,
        accountId: 'pinned-account',
        modelId: 'sol',
        provider: 'openai-oauth',
        route: 'translated',
        inputTokens: 100,
      },
    });
    collector.handle({
      kind: 'lifecycle',
      entry: {
        event: 'response_completed',
        requestId,
        modelId: 'sol',
        provider: 'openai-oauth',
        route: 'translated',
      },
    });

    expect(metrics.readSince(0, 'pinned-account')).toEqual([
      expect.objectContaining({ requestId, accountId: 'pinned-account' }),
    ]);
    metrics.close();
  });

  it('prices custom aliases using the resolved upstream model', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-collector-'));
    roots.push(root);
    const metrics = new DaemonMetricsStore(join(root, 'metrics.sqlite'));
    const collector = new DaemonInferenceCollector(metrics);
    const requestId = 'alias-request';
    collector.handle({
      kind: 'request',
      entry: {
        requestId,
        accountId: 'account-a',
        modelId: 'orbit',
        resolvedModelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
      },
    });
    collector.handle({
      kind: 'lifecycle',
      entry: {
        event: 'response_completed',
        requestId,
        modelId: 'orbit',
        resolvedModelId: 'gpt-5.6-sol',
        provider: 'openai-oauth',
        route: 'translated',
        inputTokens: 100_000,
        outputTokens: 1_000,
      },
    });

    const bucket = metrics.bucketsRange(0, Date.now() + 1_000, Date.now() + 1_000, 'account-a')
      .find(candidate => candidate.requests === 1);
    expect(metrics.readSince(0, 'account-a')[0]?.modelId).toBe('gpt-5.6-sol');
    expect(bucket?.pricedRequests).toBe(1);
    expect(bucket?.unpricedRequests).toBe(0);
    metrics.close();
  });

  it('retains compaction lifecycle sizes and local thread identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-collector-'));
    roots.push(root);
    const metrics = new DaemonMetricsStore(join(root, 'metrics.sqlite'));
    const sessionId = '10a1f5d9-490e-4444-911d-ecc365a07bad';
    const collector = new DaemonInferenceCollector(metrics, id => (
      id === sessionId ? 'typing cleanup efforts continued' : undefined
    ));

    collector.handle({
      kind: 'websocket',
      entry: {
        event: 'ws_compaction',
        outcome: 'completed',
        stage: 2,
        transport: 'responses_compact_endpoint',
        reason: 'known_oversized',
        estimatedInputTokens: 684_341,
        inputTokens: 263_145,
        outputTokens: 4_627,
        estimatedRebasedTokens: 438_908,
        durationMs: 93_897,
        requestId: 'compact-request',
        claudeSessionId: sessionId,
      },
    });

    expect(collector.recentDiagnostics()).toEqual([
      expect.objectContaining({
        kind: 'ws_compaction',
        requestId: 'compact-request',
        sessionId,
        threadName: 'typing cleanup efforts continued',
        detail: expect.objectContaining({
          outcome: 'completed',
          stage: 2,
          inputTokens: 263_145,
          outputTokens: 4_627,
          estimatedRebasedTokens: 438_908,
          durationMs: 93_897,
        }),
      }),
    ]);
    metrics.close();
  });
});
