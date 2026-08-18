import { isObject, isString } from '../runtime/type-guards.js';
import { getDaemonControlSocketPath } from '../config/paths.js';
import { normalizeControlRoute } from './control-diagnostics.js';

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
  const timeoutMs = options.timeoutMs ?? 2_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const startedAt = performance.now();
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
      const elapsedMs = Math.round(performance.now() - startedAt);
      throw new Error(
        `Clodex daemon request timed out after ${elapsedMs}ms`
        + ` (budget ${timeoutMs}ms): ${method}`
        + ` ${normalizeControlRoute(`http://clodex.local${path}`)}`,
        { cause: error },
      );
    }
    throw error;
  }

  const raw = await response.text();
  let parsed: T;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Invalid daemon response (${response.status})`);
  }
  if (!response.ok) {
    const message = parsed && isObject(parsed)
      && 'error' in parsed
      && isString(parsed.error)
      ? parsed.error
      : `Daemon request failed (${response.status})`;
    throw new Error(message);
  }
  return parsed;
}
