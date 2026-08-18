import { performance } from 'node:perf_hooks';
import type { DaemonDiagnostic } from './collector.js';

const DEFAULT_EVENT_LOOP_SAMPLE_MS = 1_000;
const DEFAULT_EVENT_LOOP_STALL_MS = 1_000;
const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_STALLED_REQUEST_MS = 5_000;

type EmitDiagnostic = (diagnostic: DaemonDiagnostic) => void;

export interface ControlRequestDiagnosticsOptions {
  emit: EmitDiagnostic;
  log?: (message: string) => void;
  eventLoopSampleMs?: number;
  eventLoopStallMs?: number;
  slowRequestMs?: number;
  stalledRequestMs?: number;
}

interface ActiveControlRequest {
  id: number;
  method: string;
  route: string;
  startedAt: number;
}

interface ControlDiagnosticExtra {
  phase: 'pending' | 'failed' | 'completed';
  thresholdMs?: number;
  durationMs?: number;
  errorType?: string;
  statusCode?: number;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

export function normalizeControlRoute(requestUrl: string): string {
  const url = new URL(requestUrl);
  let pathname = url.pathname;
  pathname = pathname.replace(/^\/v1\/accounts\/[^/]+\/select$/, '/v1/accounts/:id/select');
  const keys = [...new Set(url.searchParams.keys())].toSorted();
  return keys.length > 0 ? `${pathname}?${keys.join('&')}` : pathname;
}

export class ControlRequestDiagnostics {
  private readonly active = new Map<number, ActiveControlRequest>();
  private readonly emit: EmitDiagnostic;
  private readonly log: (message: string) => void;
  private readonly slowRequestMs: number;
  private readonly stalledRequestMs: number;
  private readonly eventLoopSampleMs: number;
  private readonly eventLoopStallMs: number;
  private eventLoopTimer?: ReturnType<typeof setInterval>;
  private expectedSampleAt = performance.now();
  private latestEventLoopLagMs = 0;
  private peakEventLoopLagMs = 0;
  private nextRequestId = 1;

  constructor(options: ControlRequestDiagnosticsOptions) {
    this.emit = options.emit;
    this.log = options.log ?? (message => console.warn(message));
    this.slowRequestMs = options.slowRequestMs ?? DEFAULT_SLOW_REQUEST_MS;
    this.stalledRequestMs = options.stalledRequestMs ?? DEFAULT_STALLED_REQUEST_MS;
    this.eventLoopSampleMs = options.eventLoopSampleMs ?? DEFAULT_EVENT_LOOP_SAMPLE_MS;
    this.eventLoopStallMs = options.eventLoopStallMs ?? DEFAULT_EVENT_LOOP_STALL_MS;
    this.expectedSampleAt += this.eventLoopSampleMs;
    this.eventLoopTimer = setInterval(() => this.sampleEventLoop(), this.eventLoopSampleMs);
    this.eventLoopTimer.unref();
  }

  async track(request: Request, handle: () => Promise<Response>): Promise<Response> {
    const activeRequest: ActiveControlRequest = {
      id: this.nextRequestId++,
      method: request.method,
      route: normalizeControlRoute(request.url),
      startedAt: performance.now(),
    };
    this.active.set(activeRequest.id, activeRequest);
    const stallTimer = setTimeout(() => {
      this.report('control_request_stalled', activeRequest, {
        phase: 'pending',
        thresholdMs: this.stalledRequestMs,
      });
    }, this.stalledRequestMs);
    stallTimer.unref();

    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await handle();
      return response;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      clearTimeout(stallTimer);
      this.active.delete(activeRequest.id);
      const durationMs = performance.now() - activeRequest.startedAt;
      if (failure !== undefined) {
        this.report('control_request_failed', activeRequest, {
          phase: 'failed',
          durationMs,
          errorType: failure instanceof Error
            ? failure.name
            : Object.prototype.toString.call(failure),
        });
      } else if (durationMs >= this.slowRequestMs) {
        this.report('control_request_slow', activeRequest, {
          phase: 'completed',
          durationMs,
          statusCode: response?.status,
        });
      }
    }
  }

  close(): void {
    if (this.eventLoopTimer) clearInterval(this.eventLoopTimer);
    this.eventLoopTimer = undefined;
    this.active.clear();
  }

  private sampleEventLoop(): void {
    const now = performance.now();
    this.latestEventLoopLagMs = Math.max(0, now - this.expectedSampleAt);
    this.peakEventLoopLagMs = Math.max(this.peakEventLoopLagMs, this.latestEventLoopLagMs);
    this.expectedSampleAt = now + this.eventLoopSampleMs;
    if (this.latestEventLoopLagMs >= this.eventLoopStallMs) {
      this.reportEventLoopStall();
    }
  }

  private report(
    kind: string,
    request: ActiveControlRequest,
    extra: ControlDiagnosticExtra,
  ): void {
    const memory = process.memoryUsage();
    const detail = {
      controlRequestId: request.id,
      method: request.method,
      route: request.route,
      durationMs: rounded(performance.now() - request.startedAt),
      activeControlRequests: this.active.size,
      eventLoopLagMs: rounded(this.latestEventLoopLagMs),
      peakEventLoopLagMs: rounded(this.peakEventLoopLagMs),
      rssMiB: rounded(memory.rss / 1024 / 1024),
      heapUsedMiB: rounded(memory.heapUsed / 1024 / 1024),
      ...extra,
    };
    const diagnostic: DaemonDiagnostic = {
      timestamp: new Date().toISOString(),
      kind,
      detail,
    };
    this.emit(diagnostic);
    this.log(`[clodex-control] ${JSON.stringify(diagnostic)}`);
  }

  private reportEventLoopStall(): void {
    const memory = process.memoryUsage();
    const diagnostic: DaemonDiagnostic = {
      timestamp: new Date().toISOString(),
      kind: 'daemon_event_loop_stall',
      detail: {
        eventLoopLagMs: rounded(this.latestEventLoopLagMs),
        peakEventLoopLagMs: rounded(this.peakEventLoopLagMs),
        activeControlRequests: this.active.size,
        activeControlRoutes: [...this.active.values()].slice(0, 8).map(request => request.route),
        rssMiB: rounded(memory.rss / 1024 / 1024),
        heapUsedMiB: rounded(memory.heapUsed / 1024 / 1024),
      },
    };
    this.emit(diagnostic);
    this.log(`[clodex-control] ${JSON.stringify(diagnostic)}`);
  }
}
