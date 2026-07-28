import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getDaemonMetricsPath } from '../paths.js';

const METRICS_FILE_MAX_BYTES = 32 * 1024 * 1024;
const METRICS_RETENTION_MS = 30 * 24 * 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 5 * 60_000;

export interface DaemonMetricEvent {
  timestamp: string;
  requestId?: string;
  sessionHash?: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  durationMs?: number;
  error: boolean;
  cancelled?: boolean;
}

export interface DaemonMetricBucket {
  timestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  requests: number;
  errors: number;
  cancellations: number;
  durationMs: number;
}

export function hashSessionId(value: string | undefined): string | undefined {
  return value
    ? createHash('sha256').update(value).digest('hex').slice(0, 16)
    : undefined;
}

function safeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function parseMetricLine(line: string): DaemonMetricEvent | null {
  try {
    const value = JSON.parse(line) as Partial<DaemonMetricEvent>;
    if (
      typeof value.timestamp !== 'string'
      || typeof value.modelId !== 'string'
      || typeof value.provider !== 'string'
    ) return null;
    return {
      timestamp: value.timestamp,
      ...(typeof value.requestId === 'string' ? { requestId: value.requestId.slice(0, 100) } : {}),
      ...(typeof value.sessionHash === 'string' ? { sessionHash: value.sessionHash.slice(0, 32) } : {}),
      modelId: value.modelId.slice(0, 200),
      provider: value.provider.slice(0, 100),
      inputTokens: safeInteger(value.inputTokens),
      cachedInputTokens: safeInteger(value.cachedInputTokens),
      cacheWriteTokens: safeInteger(value.cacheWriteTokens),
      outputTokens: safeInteger(value.outputTokens),
      ...(value.durationMs !== undefined ? { durationMs: safeInteger(value.durationMs) } : {}),
      error: value.error === true,
      cancelled: value.cancelled === true,
    };
  } catch {
    return null;
  }
}

export class DaemonMetricsStore {
  readonly path: string;
  readonly archivePath: string;
  private events: DaemonMetricEvent[];
  private activeBytes: number;
  private lastPrunedAt = 0;
  private readonly maxFileBytes: number;

  constructor(
    path = getDaemonMetricsPath(),
    options: { maxFileBytes?: number } = {},
  ) {
    this.path = path;
    this.archivePath = `${path}.1`;
    this.maxFileBytes = options.maxFileBytes ?? METRICS_FILE_MAX_BYTES;
    this.events = [
      ...this.readFile(this.archivePath),
      ...this.readFile(this.path),
    ];
    this.activeBytes = this.fileBytes(this.path);
    this.prune(Date.now(), true);
  }

  append(event: DaemonMetricEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.activeBytes > 0 && this.activeBytes + bytes > this.maxFileBytes) {
        this.rotate();
      }
      appendFileSync(this.path, line, { mode: 0o600 });
      chmodSync(this.path, 0o600);
      this.activeBytes += bytes;
      this.events.push(event);
      this.prune(Date.now());
    } catch {
      // Metrics must never alter inference behavior.
    }
  }

  readSince(sinceMs: number): DaemonMetricEvent[] {
    return this.events.filter(event => {
      const timestamp = Date.parse(event.timestamp);
      return Number.isFinite(timestamp) && timestamp >= sinceMs;
    });
  }

  buckets(
    windowMs = 24 * 60 * 60_000,
    bucketMs = FIVE_MINUTES_MS,
    now = Date.now(),
  ): DaemonMetricBucket[] {
    const since = now - windowMs;
    const byStart = new Map<number, DaemonMetricBucket>();
    const firstBucket = Math.floor(since / bucketMs) * bucketMs;
    const lastBucket = Math.floor(now / bucketMs) * bucketMs;
    for (let start = firstBucket; start <= lastBucket; start += bucketMs) {
      byStart.set(start, {
        timestamp: new Date(start).toISOString(),
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        requests: 0,
        errors: 0,
        cancellations: 0,
        durationMs: 0,
      });
    }
    for (const event of this.readSince(since)) {
      const eventMs = Date.parse(event.timestamp);
      const start = Math.floor(eventMs / bucketMs) * bucketMs;
      let bucket = byStart.get(start);
      if (!bucket) continue;
      bucket.inputTokens += event.inputTokens;
      bucket.cachedInputTokens += event.cachedInputTokens;
      bucket.cacheWriteTokens += event.cacheWriteTokens;
      bucket.outputTokens += event.outputTokens;
      bucket.requests += 1;
      bucket.errors += event.error ? 1 : 0;
      bucket.cancellations += event.cancelled ? 1 : 0;
      bucket.durationMs += event.durationMs ?? 0;
    }
    return [...byStart.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  private readFile(path: string): DaemonMetricEvent[] {
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map(parseMetricLine)
      .filter((event): event is DaemonMetricEvent => Boolean(event));
  }

  private fileBytes(path: string): number {
    try {
      return Buffer.byteLength(readFileSync(path));
    } catch {
      return 0;
    }
  }

  private rotate(): void {
    rmSync(this.archivePath, { force: true });
    renameSync(this.path, this.archivePath);
    writeFileSync(this.path, '', { mode: 0o600 });
    this.activeBytes = 0;
  }

  private prune(now: number, force = false): void {
    if (!force && now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    const cutoff = now - METRICS_RETENTION_MS;
    this.events = this.events.filter(event => {
      const timestamp = Date.parse(event.timestamp);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    this.lastPrunedAt = now;
  }
}
