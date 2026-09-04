import { afterEach, describe, expect, it } from 'bun:test';
import { loadBunNativeWebSocket } from '../src/transport/bun-websocket.js';

const servers: Bun.Server<any>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('Bun native WebSocket adapter', () => {
  it('accepts a successful native Bun upgrade and receives frames', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, instance) {
        return instance.upgrade(request)
          ? undefined
          : new Response('upgrade required', { status: 426 });
      },
      websocket: {
        open(socket) {
          socket.send('native-ok');
        },
        message() {},
      },
    });
    servers.push(server);
    const WebSocket = loadBunNativeWebSocket();
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: {} });
    expect(socket.pause()).toBe(true);
    expect(socket.resume()).toBe(true);

    const result = await new Promise<string>((resolve, reject) => {
      socket.once('message', data => resolve(data.toString('utf8')));
      socket.once('error', reject);
    });

    expect(result).toBe('native-ok');
    socket.close();
  });

  it('preserves rejected-upgrade status and retry-after with a failure-only native probe', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('throttled', {
        status: 403,
        headers: { 'retry-after': '7' },
      }),
    });
    servers.push(server);
    const WebSocket = loadBunNativeWebSocket();
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: {} });

    const result = await new Promise<{ status: number; retryAfter: string | undefined }>(
      (resolve, reject) => {
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve({
            status: response.statusCode,
            retryAfter: response.headers['retry-after'],
          });
        });
        socket.once('error', reject);
      },
    );

    expect(result).toEqual({
      status: 403,
      retryAfter: '7',
    });
  });
});
