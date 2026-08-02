import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION } from '../constants.js';
import { responsesWebSocketPoolSnapshot } from '../oauth/responses-websocket.js';
import { DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS } from '../timeouts.js';
import type { DaemonRuntimeState } from './runtime.js';
import type { DaemonInferenceCollector } from './collector.js';
import type { SecondwindSnapshot } from './secondwind.js';
import type { DiagnosticLogMode, SecondwindMode } from '../types.js';
import type {
  DaemonClaudeModelSnapshot,
} from './model-service.js';
import { ControlRequestDiagnostics } from './control-diagnostics.js';

const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_METRICS_RANGE_MS = 32 * 24 * 60 * 60_000;
const MAX_METRICS_BUCKETS = 1_000;

export interface DaemonAccountView {
  id: string;
  email?: string;
  selected: boolean;
  plan?: string;
  usage?: Record<string, unknown>;
}

export interface DaemonAccountController {
  list(): Promise<DaemonAccountView[]> | DaemonAccountView[];
  select(id: string): Promise<void> | void;
  refreshUsage?(): Promise<void>;
  createLaunchTicket(accountId?: string): {
    ticket: string;
    accountId: string;
    accountLabel: string;
  } | null;
}

interface DaemonSecondwindController {
  snapshot(): SecondwindSnapshot;
  setMode(mode: SecondwindMode): void;
}

interface DaemonDiagnosticLogController {
  snapshot(): { mode: DiagnosticLogMode };
  setMode(mode: DiagnosticLogMode): void;
}

interface DaemonClaudeModelController {
  snapshot(): DaemonClaudeModelSnapshot;
  setEnabled(modelId: string, enabled: boolean): Promise<DaemonClaudeModelSnapshot>;
}

export interface DaemonControlApiOptions {
  socketPath: string;
  runtime: DaemonRuntimeState;
  collector: DaemonInferenceCollector;
  accounts: DaemonAccountController;
  secondwind: DaemonSecondwindController;
  diagnosticLogs: DaemonDiagnosticLogController;
  models: DaemonClaudeModelController;
  requestRestart: () => void;
  requestStop: () => void;
}

export interface DaemonControlApiHandle {
  close: () => Promise<void>;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_CONTROL_BODY_BYTES) {
    throw new Error('Control request body is too large');
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_CONTROL_BODY_BYTES) {
    throw new Error('Control request body is too large');
  }
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    },
  });
}

export async function dispatchDaemonControlRequest(
  options: DaemonControlApiOptions,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        return sendJson(200, {
          ok: true,
          protocolVersion: options.runtime.protocolVersion,
          instanceId: options.runtime.instanceId,
          version: VERSION,
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const sessions = options.collector.sessions.snapshot();
        return sendJson(200, {
          running: true,
          ready: options.runtime.ready,
          version: VERSION,
          pid: process.pid,
          instanceId: options.runtime.instanceId,
          startedAt: options.runtime.startedAt,
          uptimeSeconds: Math.floor(process.uptime()),
          port: options.runtime.port,
          controlSocketPath: options.socketPath,
          websocket: responsesWebSocketPoolSnapshot(),
          activeSessions: sessions.filter(session => session.activeRequests > 0).length,
          sessions,
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/metrics') {
        const now = Date.now();
        const requestedStart = Date.parse(url.searchParams.get('start') ?? '');
        const requestedEnd = Date.parse(url.searchParams.get('end') ?? '');
        const hasRange = Number.isFinite(requestedStart) && Number.isFinite(requestedEnd);
        const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get('hours') ?? 24)));
        const startMs = hasRange ? requestedStart : now - windowHours * 60 * 60_000;
        const endMs = hasRange ? requestedEnd : now;
        if (endMs <= startMs || endMs - startMs > MAX_METRICS_RANGE_MS) {
          return sendJson(400, { error: 'Metrics range must be positive and no longer than 32 days' });
        }
        const requestedBucketMinutes = Number(url.searchParams.get('bucketMinutes') ?? 5);
        if (!Number.isFinite(requestedBucketMinutes)) {
          return sendJson(400, { error: 'bucketMinutes must be a finite number' });
        }
        const bucketMinutes = Math.max(1, Math.min(24 * 60, requestedBucketMinutes));
        const bucketMs = bucketMinutes * 60_000;
        if (Math.ceil((endMs - startMs) / bucketMs) > MAX_METRICS_BUCKETS) {
          return sendJson(400, { error: `Metrics range exceeds ${MAX_METRICS_BUCKETS} buckets` });
        }
        const accountId = url.searchParams.get('accountId')?.trim() || undefined;
        return sendJson(200, {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          bucketMinutes,
          accountId,
          buckets: options.collector.metrics.bucketsRange(
            startMs,
            endMs,
            bucketMs,
            accountId,
          ),
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return sendJson(200, {
          diagnostics: options.collector.recentDiagnostics(limit),
          ...options.diagnosticLogs.snapshot(),
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/diagnostics/mode') {
        const body = await readJsonBody(request);
        const mode = body && typeof body === 'object'
          ? (body as { mode?: unknown }).mode
          : undefined;
        if (mode !== 'all' && mode !== 'error') {
          return sendJson(400, { error: 'Diagnostic log mode must be all or error' });
        }
        options.diagnosticLogs.setMode(mode);
        return sendJson(200, options.diagnosticLogs.snapshot());
      }
      if (request.method === 'GET' && url.pathname === '/v1/secondwind') {
        return sendJson(200, options.secondwind.snapshot());
      }
      if (request.method === 'POST' && url.pathname === '/v1/secondwind/mode') {
        const body = await readJsonBody(request);
        const mode = body && typeof body === 'object'
          ? (body as { mode?: unknown }).mode
          : undefined;
        if (mode !== 'off' && mode !== 'shadow' && mode !== 'on') {
          return sendJson(400, { error: 'Secondwind mode must be off, shadow, or on' });
        }
        options.secondwind.setMode(mode);
        return sendJson(200, options.secondwind.snapshot());
      }
      if (request.method === 'GET' && url.pathname === '/v1/claude/models') {
        return sendJson(200, options.models.snapshot());
      }
      if (request.method === 'POST' && url.pathname === '/v1/claude/models') {
        const body = await readJsonBody(request);
        const modelId = body && typeof body === 'object'
          ? (body as { modelId?: unknown }).modelId
          : undefined;
        const enabled = body && typeof body === 'object'
          ? (body as { enabled?: unknown }).enabled
          : undefined;
        if (typeof modelId !== 'string' || !modelId.trim()) {
          return sendJson(400, { error: 'Claude modelId must be a non-empty string' });
        }
        if (typeof enabled !== 'boolean') {
          return sendJson(400, { error: 'Claude model enabled must be a boolean' });
        }
        return sendJson(200, await options.models.setEnabled(modelId, enabled));
      }
      if (request.method === 'GET' && url.pathname === '/v1/accounts') {
        if (url.searchParams.get('refresh') === '1') await options.accounts.refreshUsage?.();
        return sendJson(200, { accounts: await options.accounts.list() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/launches/attach') {
        const body = await readJsonBody(request);
        const accountId = body && typeof body === 'object'
          && typeof (body as { accountId?: unknown }).accountId === 'string'
          ? (body as { accountId: string }).accountId
          : undefined;
        return sendJson(201, options.accounts.createLaunchTicket(accountId));
      }
      const accountSelect = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/select$/);
      if (request.method === 'POST' && accountSelect) {
        await readJsonBody(request);
        await options.accounts.select(decodeURIComponent(accountSelect[1]!));
        return sendJson(200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/v1/service/restart') {
        setTimeout(options.requestRestart, 25).unref();
        return sendJson(202, { ok: true, action: 'restart' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/service/stop') {
        const body = await readJsonBody(request);
        const instanceId = body && typeof body === 'object'
          ? (body as { instanceId?: unknown }).instanceId
          : undefined;
        if (instanceId !== options.runtime.instanceId) {
          return sendJson(409, { error: 'Daemon instance changed; refusing stale stop request' });
        }
        setTimeout(options.requestStop, 25).unref();
        return sendJson(202, { ok: true, action: 'stop' });
      }
  return sendJson(404, { error: 'Unknown daemon control endpoint' });
}

export function startDaemonControlApi(
  options: DaemonControlApiOptions,
): DaemonControlApiHandle {
  rmSync(options.socketPath, { force: true });
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });

  const diagnostics = new ControlRequestDiagnostics({
    emit: diagnostic => options.collector.recordDiagnostic(diagnostic),
  });
  const server = Bun.serve({
    unix: options.socketPath,
    maxRequestBodySize: MAX_CONTROL_BODY_BYTES,
    async fetch(request, bunServer) {
      bunServer.timeout(request, DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS);
      return diagnostics.track(
        request,
        () => dispatchDaemonControlRequest(options, request),
      ).catch(error => sendJson(400, {
        error: error instanceof Error ? error.message : String(error),
      }));
    },
  });

  chmodSync(options.socketPath, 0o600);
  return {
    close: async () => {
      diagnostics.close();
      await server.stop(true);
      rmSync(options.socketPath, { force: true });
    },
  };
}
