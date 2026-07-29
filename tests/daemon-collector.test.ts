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
          modelId: 'gpt-5.6-sol',
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
});
