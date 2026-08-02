import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { VERSION } from '../../constants.js';
import { DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS } from '../../timeouts.js';
import { createDaemonAccountController } from '../account-service.js';
import type {
  ControlWorkerCommand,
  ControlWorkerEvent,
  SerializedControlRequest,
  SerializedControlResponse,
} from './protocol.js';

declare const self: Worker;

const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const pending = new Map<number, {
  resolve: (response: SerializedControlResponse) => void;
  reject: (error: Error) => void;
}>();
let nextRequestId = 1;
let server: Bun.Server<undefined> | undefined;
let activeSocketPath: string | undefined;

function sendJson(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_CONTROL_BODY_BYTES) {
    throw new Error('Control request body is too large');
  }
  return raw ? JSON.parse(raw) : undefined;
}

async function forwardToMain(request: Request): Promise<Response> {
  const id = nextRequestId++;
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await request.text();
  const forwarded: SerializedControlRequest = {
    id,
    method: request.method,
    url: request.url,
    headers: [...request.headers.entries()],
    ...(body ? { body } : {}),
  };
  const response = await new Promise<SerializedControlResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    postMessage({ type: 'request', request: forwarded } satisfies ControlWorkerEvent);
  });
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

function start(command: Extract<ControlWorkerCommand, { type: 'start' }>): void {
  const { runtime, socketPath } = command;
  activeSocketPath = socketPath;
  const accounts = createDaemonAccountController();
  rmSync(socketPath, { force: true });
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  server = Bun.serve({
    unix: socketPath,
    maxRequestBodySize: MAX_CONTROL_BODY_BYTES,
    async fetch(request, bunServer) {
      bunServer.timeout(request, DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS);
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/v1/health') {
          return sendJson(200, {
            ok: true,
            protocolVersion: runtime.protocolVersion,
            instanceId: runtime.instanceId,
            version: VERSION,
          });
        }
        if (request.method === 'POST' && url.pathname === '/v1/launches/attach') {
          const body = await readJsonBody(request);
          const accountId = body && typeof body === 'object'
            && typeof (body as { accountId?: unknown }).accountId === 'string'
            ? (body as { accountId: string }).accountId
            : undefined;
          return sendJson(201, accounts.createLaunchTicket(accountId));
        }
        return await forwardToMain(request);
      } catch (error) {
        return sendJson(400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  chmodSync(socketPath, 0o600);
  postMessage({ type: 'ready' } satisfies ControlWorkerEvent);
}

self.onmessage = (event: MessageEvent<ControlWorkerCommand>) => {
  const command = event.data;
  if (command.type === 'response') {
    const waiter = pending.get(command.response.id);
    if (!waiter) return;
    pending.delete(command.response.id);
    waiter.resolve(command.response);
    return;
  }
  if (command.type === 'close') {
    for (const waiter of pending.values()) waiter.reject(new Error('Daemon control worker closed'));
    pending.clear();
    void server?.stop(true).finally(() => {
      if (activeSocketPath) rmSync(activeSocketPath, { force: true });
      postMessage({ type: 'closed' } satisfies ControlWorkerEvent);
      process.exit(0);
    });
    return;
  }
  try {
    start(command);
  } catch (error) {
    postMessage({
      type: 'failed',
      message: error instanceof Error ? error.message : String(error),
    } satisfies ControlWorkerEvent);
  }
};
