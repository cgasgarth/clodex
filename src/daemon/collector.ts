import type { InferenceTraceEvent } from '../trace-log.js';
import { DaemonMetricsStore, hashSessionId } from './metrics.js';
import { DaemonSessionRegistry } from './session-registry.js';

interface PendingUsage {
  requestId: string;
  sessionHash?: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  durationMs?: number;
}

export interface DaemonDiagnostic {
  timestamp: string;
  kind: string;
  requestId?: string;
  sessionHash?: string;
  code?: string;
  statusCode?: number;
  detail?: Record<string, unknown>;
}

const TERMINAL_EVENTS = new Set([
  'response_completed',
  'response_failed',
  'response_client_disconnected',
]);

export class DaemonInferenceCollector {
  readonly sessions = new DaemonSessionRegistry();
  readonly metrics: DaemonMetricsStore;
  private readonly pending = new Map<string, PendingUsage>();
  private readonly diagnostics: DaemonDiagnostic[] = [];

  constructor(metrics = new DaemonMetricsStore()) {
    this.metrics = metrics;
  }

  handle(event: InferenceTraceEvent): void {
    const now = new Date();
    if (event.kind === 'request') {
      const entry = event.entry;
      const requestId = entry.requestId ?? `untracked-${now.getTime()}`;
      const sessionHash = hashSessionId(entry.claudeSessionId);
      this.pending.set(requestId, {
        requestId,
        sessionHash,
        modelId: entry.modelId,
        provider: entry.provider,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      });
      this.sessions.requestStarted(
        sessionHash,
        requestId,
        entry.modelId,
        entry.provider,
        now,
      );
      return;
    }

    if (event.kind === 'lifecycle') {
      const entry = event.entry;
      const requestId = entry.requestId;
      const sessionHash = hashSessionId(entry.claudeSessionId);
      const usage = this.pending.get(requestId) ?? {
        requestId,
        sessionHash,
        modelId: entry.modelId,
        provider: entry.provider,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      };
      usage.inputTokens = Math.max(usage.inputTokens, entry.inputTokens ?? 0);
      usage.cachedInputTokens = Math.max(
        usage.cachedInputTokens,
        entry.cacheReadInputTokens ?? 0,
      );
      usage.cacheWriteTokens = Math.max(
        usage.cacheWriteTokens,
        entry.cacheCreationInputTokens ?? 0,
      );
      usage.outputTokens = Math.max(usage.outputTokens, entry.outputTokens ?? 0);
      if (entry.durationMs !== undefined) usage.durationMs = entry.durationMs;
      this.pending.set(requestId, usage);

      if (!TERMINAL_EVENTS.has(entry.event)) return;
      const outcome = entry.event === 'response_client_disconnected'
        ? 'cancelled'
        : entry.event.includes('failed')
          ? 'failed'
          : 'completed';
      this.finish(usage, outcome, now);
      if (outcome === 'failed') {
        this.pushDiagnostic({
          timestamp: now.toISOString(),
          kind: entry.event,
          requestId,
          sessionHash,
          code: entry.errorCode ?? entry.errorType,
          ...(entry.statusCode !== undefined ? { statusCode: entry.statusCode } : {}),
          detail: {
            phase: entry.phase,
            failureSource: entry.failureSource,
            terminationSource: entry.terminationSource,
            errorSignature: entry.errorSignature,
          },
        });
      }
      return;
    }

    if (event.kind === 'upstream_error') {
      const entry = event.entry;
      this.pushDiagnostic({
        timestamp: now.toISOString(),
        kind: 'upstream_error',
        requestId: entry.requestId,
        statusCode: entry.statusCode,
        detail: {
          modelId: entry.modelId,
          provider: entry.provider,
          retryable: entry.isRetryable,
          attempts: entry.attemptCount,
        },
      });
      return;
    }

    if (event.kind === 'route_unavailable') {
      this.pushDiagnostic({
        timestamp: now.toISOString(),
        kind: 'route_unavailable',
        requestId: event.entry.requestId,
        statusCode: event.entry.statusCode,
        detail: { modelId: event.entry.modelId },
      });
      return;
    }

    const diagnosticEvent = event.entry;
    const eventName = typeof diagnosticEvent.event === 'string'
      ? diagnosticEvent.event
      : 'websocket';
    if (
      eventName.includes('failed')
      || eventName.includes('error')
      || eventName.includes('compact')
      || eventName.includes('retry')
    ) {
      this.pushDiagnostic({
        timestamp: now.toISOString(),
        kind: eventName,
        requestId: typeof diagnosticEvent.requestId === 'string'
          ? diagnosticEvent.requestId
          : undefined,
        sessionHash: hashSessionId(
          typeof diagnosticEvent.claudeSessionId === 'string'
            ? diagnosticEvent.claudeSessionId
            : undefined,
        ),
        detail: sanitizeDiagnosticDetail(diagnosticEvent),
      });
    }
  }

  recentDiagnostics(limit = 50): DaemonDiagnostic[] {
    return this.diagnostics.slice(-Math.max(1, Math.min(limit, 200))).reverse();
  }

  private finish(
    usage: PendingUsage,
    outcome: 'completed' | 'cancelled' | 'failed',
    now: Date,
  ): void {
    this.pending.delete(usage.requestId);
    this.metrics.append({
      timestamp: now.toISOString(),
      requestId: usage.requestId,
      sessionHash: usage.sessionHash,
      modelId: usage.modelId,
      provider: usage.provider,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      durationMs: usage.durationMs,
      error: outcome === 'failed',
      cancelled: outcome === 'cancelled',
    });
    this.sessions.requestFinished(usage.sessionHash, usage.requestId, outcome, now);
  }

  private pushDiagnostic(diagnostic: DaemonDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > 200) this.diagnostics.splice(0, this.diagnostics.length - 200);
  }
}

function sanitizeDiagnosticDetail(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  const allowed = [
    'event',
    'decision',
    'reason',
    'status',
    'statusCode',
    'errorCode',
    'errorSignature',
    'fallbackPath',
    'durationMs',
    'estimatedInputTokens',
    'inputTokens',
    'payloadBytes',
    'wireBytes',
    'connectionCount',
    'generation',
  ];
  for (const key of allowed) {
    const value = event[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    }
  }
  return safe;
}
