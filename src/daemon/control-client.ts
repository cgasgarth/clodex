import { getDaemonControlSocketPath } from '../paths.js';

export interface DaemonControlRequestOptions {
  socketPath?: string;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
}

export async function daemonControlRequest<T>(
  path: string,
  options: DaemonControlRequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2_000);
  let response: Response;
  try {
    response = await fetch(`http://clodex.local${path}`, {
      unix: options.socketPath ?? getDaemonControlSocketPath(),
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body,
      signal: timeout,
    });
  } catch (error) {
    if (timeout.aborted) {
      throw new Error(`Clodex daemon request timed out: ${method} ${path}`);
    }
    throw error;
  }

  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Invalid daemon response (${response.status})`);
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object'
      && typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : `Daemon request failed (${response.status})`;
    throw new Error(message);
  }
  return parsed as T;
}
