import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION } from '../constants.js';
import { responsesWebSocketPoolSnapshot } from '../oauth/responses-websocket.js';
import { DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS } from './timeouts.js';
import type { DaemonRuntimeState } from './runtime.js';
import type { DaemonInferenceCollector } from './collector.js';

const MAX_CONTROL_BODY_BYTES = 64 * 1024;

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

export interface DaemonControlApiOptions {
  socketPath: string;
  runtime: DaemonRuntimeState;
  collector: DaemonInferenceCollector;
  accounts: DaemonAccountController;
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

export async function startDaemonControlApi(
  options: DaemonControlApiOptions,
): Promise<DaemonControlApiHandle> {
  rmSync(options.socketPath, { force: true });
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });

  const server = Bun.serve({
    unix: options.socketPath,
    maxRequestBodySize: MAX_CONTROL_BODY_BYTES,
    async fetch(request, bunServer) {
      bunServer.timeout(request, DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS);
      const url = new URL(request.url);
      try {
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
          proxyPort: options.runtime.proxyPort,
          endpointPort: options.runtime.endpointPort,
          controlSocketPath: options.socketPath,
          websocket: responsesWebSocketPoolSnapshot(),
          activeSessions: sessions.filter(session => session.activeRequests > 0).length,
          sessions,
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/metrics') {
        const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get('hours') ?? 24)));
        const bucketMinutes = Math.max(1, Math.min(60, Number(url.searchParams.get('bucketMinutes') ?? 5)));
        return sendJson(200, {
          windowHours,
          bucketMinutes,
          buckets: options.collector.metrics.buckets(
            windowHours * 60 * 60_000,
            bucketMinutes * 60_000,
          ),
        });
      }
      if (request.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return sendJson(200, {
          diagnostics: options.collector.recentDiagnostics(limit),
        });
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
      } catch (error) {
        return sendJson(400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  chmodSync(options.socketPath, 0o600);
  return {
    close: async () => {
      await server.stop(true);
      rmSync(options.socketPath, { force: true });
    },
  };
}
