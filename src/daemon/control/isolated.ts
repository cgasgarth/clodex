import type { DaemonControlApiHandle, DaemonControlApiOptions } from '../control-api.js';
import { dispatchDaemonControlRequest } from '../control-api.js';
import type {
  ControlWorkerCommand,
  ControlWorkerEvent,
  SerializedControlRequest,
  SerializedControlResponse,
} from './protocol.js';

export interface IsolatedDaemonControlApiOptions extends DaemonControlApiOptions {
  workerUrl?: URL;
  workerEnv?: Record<string, string>;
  startupTimeoutMs?: number;
}

function defaultWorkerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./worker.${extension}`, import.meta.url);
}

function requestFromSerialized(request: SerializedControlRequest): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
}

async function serializeResponse(id: number, response: Response): Promise<SerializedControlResponse> {
  return {
    id,
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.text(),
  };
}

export async function startIsolatedDaemonControlApi(
  options: IsolatedDaemonControlApiOptions,
): Promise<DaemonControlApiHandle> {
  const worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), {
    name: 'clodex-control-plane',
    env: options.workerEnv ?? Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  let closed = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let closeResolve: (() => void) | undefined;
  const workerClosed = new Promise<void>(resolve => {
    closeResolve = resolve;
  });
  let started = false;

  const postResponse = async (request: SerializedControlRequest): Promise<void> => {
    let response: Response;
    try {
      response = await dispatchDaemonControlRequest(options, requestFromSerialized(request));
    } catch (error) {
      response = new Response(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    worker.postMessage({
      type: 'response',
      response: await serializeResponse(request.id, response),
    } satisfies ControlWorkerCommand);
  };

  worker.onmessage = (event: MessageEvent<ControlWorkerEvent>) => {
    const message = event.data;
    if (message.type === 'ready') readyResolve?.();
    else if (message.type === 'failed') {
      if (started) options.requestStop();
      else readyReject?.(new Error(message.message));
    }
    else if (message.type === 'closed') closeResolve?.();
    else void postResponse(message.request);
  };
  worker.onerror = () => {
    const error = new Error('Daemon control worker failed');
    if (started) options.requestStop();
    else readyReject?.(error);
    closeResolve?.();
  };
  worker.addEventListener('close', () => {
    if (!closed && started) options.requestStop();
    closeResolve?.();
  });
  worker.postMessage({
    type: 'start',
    socketPath: options.socketPath,
    runtime: options.runtime,
  } satisfies ControlWorkerCommand);

  const startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Daemon control worker did not start within ${startupTimeoutMs}ms`)),
          startupTimeoutMs,
        );
      }),
    ]);
    started = true;
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        worker.postMessage({ type: 'close' } satisfies ControlWorkerCommand);
      } catch {
        closeResolve?.();
      }
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        workerClosed,
        new Promise<void>(resolve => {
          closeTimer = setTimeout(resolve, 2_000);
        }),
      ]);
      clearTimeout(closeTimer);
      worker.terminate();
    },
  };
}
