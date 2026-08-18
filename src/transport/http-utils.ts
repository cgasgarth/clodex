// Shared HTTP helpers for local proxy servers.
import type { IncomingMessage } from 'node:http';
import * as zlib from 'node:zlib';

/**
 * Decode a request body honoring Content-Encoding. Codex Desktop's built-in
 * `openai` provider zstd-compresses request bodies; without this they reach the
 * proxy as binary and JSON.parse fails with "Invalid JSON body".
 */
export function decodeRequestBody(raw: Buffer, encoding?: string | string[]): string {
  const enc = (Array.isArray(encoding) ? encoding.join(',') : encoding ?? '').toLowerCase().trim();
  if (!enc || enc === 'identity') return raw.toString();
  switch (enc) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(raw).toString();
    case 'deflate':
      return zlib.inflateSync(raw).toString();
    case 'br':
      return zlib.brotliDecompressSync(raw).toString();
    case 'zstd':
      return zlib.zstdDecompressSync(raw).toString();
    default:
      // Unknown/unsupported encoding — best-effort raw decode.
      return raw.toString();
  }
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (c: Buffer) => {
      totalSize += c.length;
      if (totalSize > 50 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(decodeRequestBody(Buffer.concat(chunks), req.headers['content-encoding']));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export interface HttpResponseWriter {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  writeHead(status: number, headers?: Record<string, string>): object;
  setHeader(name: string, value: string): object;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): object;
  destroy(error?: Error): object;
  once(event: 'drain', listener: () => void): object;
}

export function sendJson(
  res: HttpResponseWriter,
  status: number,
  body: Parameters<typeof JSON.stringify>[0],
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}
