import http from 'node:http';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION } from '../constants.js';
import { responsesWebSocketPoolSnapshot } from '../oauth/responses-websocket.js';
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

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_CONTROL_BODY_BYTES) throw new Error('Control request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function routePath(request: http.IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://clodex.local');
}

export async function startDaemonControlApi(
  options: DaemonControlApiOptions,
): Promise<DaemonControlApiHandle> {
  rmSync(options.socketPath, { force: true });
  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });

  const server = http.createServer(async (request, response) => {
    const url = routePath(request);
    try {
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, {
          ok: true,
          protocolVersion: options.runtime.protocolVersion,
          instanceId: options.runtime.instanceId,
          version: VERSION,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const sessions = options.collector.sessions.snapshot();
        sendJson(response, 200, {
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
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/metrics') {
        const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get('hours') ?? 24)));
        const bucketMinutes = Math.max(1, Math.min(60, Number(url.searchParams.get('bucketMinutes') ?? 5)));
        sendJson(response, 200, {
          windowHours,
          bucketMinutes,
          buckets: options.collector.metrics.buckets(
            windowHours * 60 * 60_000,
            bucketMinutes * 60_000,
          ),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        sendJson(response, 200, {
          diagnostics: options.collector.recentDiagnostics(limit),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/accounts') {
        if (url.searchParams.get('refresh') === '1') await options.accounts.refreshUsage?.();
        sendJson(response, 200, { accounts: await options.accounts.list() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/launches/attach') {
        const body = await readJsonBody(request);
        const accountId = body && typeof body === 'object'
          && typeof (body as { accountId?: unknown }).accountId === 'string'
          ? (body as { accountId: string }).accountId
          : undefined;
        sendJson(response, 201, options.accounts.createLaunchTicket(accountId));
        return;
      }
      const accountSelect = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/select$/);
      if (request.method === 'POST' && accountSelect) {
        await readJsonBody(request);
        await options.accounts.select(decodeURIComponent(accountSelect[1]!));
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/service/restart') {
        sendJson(response, 202, { ok: true, action: 'restart' });
        setTimeout(options.requestRestart, 25).unref();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/service/stop') {
        const body = await readJsonBody(request);
        const instanceId = body && typeof body === 'object'
          ? (body as { instanceId?: unknown }).instanceId
          : undefined;
        if (instanceId !== options.runtime.instanceId) {
          sendJson(response, 409, { error: 'Daemon instance changed; refusing stale stop request' });
          return;
        }
        sendJson(response, 202, { ok: true, action: 'stop' });
        setTimeout(options.requestStop, 25).unref();
        return;
      }
      sendJson(response, 404, { error: 'Unknown daemon control endpoint' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(options.socketPath, 0o600);
  return {
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(options.socketPath, { force: true });
    },
  };
}
