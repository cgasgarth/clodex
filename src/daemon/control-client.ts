import http from 'node:http';
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
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<T>((resolve, reject) => {
    const request = http.request({
      socketPath: options.socketPath ?? getDaemonControlSocketPath(),
      path,
      method: options.method ?? 'GET',
      headers: body
        ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          }
        : undefined,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          reject(new Error(`Invalid daemon response (${response.statusCode ?? 0})`));
          return;
        }
        if ((response.statusCode ?? 500) >= 400) {
          const message = parsed && typeof parsed === 'object'
            && typeof (parsed as { error?: unknown }).error === 'string'
            ? (parsed as { error: string }).error
            : `Daemon request failed (${response.statusCode ?? 0})`;
          reject(new Error(message));
          return;
        }
        resolve(parsed as T);
      });
    });
    request.setTimeout(options.timeoutMs ?? 2_000, () => {
      request.destroy(new Error('Clodex daemon request timed out'));
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}
