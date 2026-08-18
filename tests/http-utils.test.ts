import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import { readBody } from '../src/transport/http-utils.js';

function mockRequest(body: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  // SAFETY: The test fixture defines the asserted runtime shape.
  const req = new EventEmitter() as IncomingMessage;
  Object.defineProperty(req, 'headers', { value: headers, writable: true });
  queueMicrotask(() => {
    req.emit('data', body);
    req.emit('end');
  });
  return req;
}

describe('readBody content-encoding decoding', () => {
  const payload = JSON.stringify({ model: 'gpt-4o', input: 'hello' });

  it('returns plain bodies unchanged', async () => {
    const out = await readBody(mockRequest(Buffer.from(payload)));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });

  it('decompresses zstd request bodies (Codex Desktop openai provider)', async () => {
    const out = await readBody(mockRequest(zstdCompressSync(Buffer.from(payload)), { 'content-encoding': 'zstd' }));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });

  it('decompresses gzip request bodies', async () => {
    const out = await readBody(mockRequest(gzipSync(Buffer.from(payload)), { 'content-encoding': 'gzip' }));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });

  it('treats identity encoding as plain text', async () => {
    const out = await readBody(mockRequest(Buffer.from(payload), { 'content-encoding': 'identity' }));
    expect(JSON.parse(out)).toEqual({ model: 'gpt-4o', input: 'hello' });
  });
});
