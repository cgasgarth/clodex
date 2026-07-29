import { EventEmitter } from 'node:events';

type SendCallback = (error?: Error) => void;

export interface BunWebSocketOptions {
  headers: Record<string, string>;
  proxy?: string;
}

/**
 * Small `ws`-shaped adapter over Bun's native WebSocket client.
 *
 * Bun aliases `import 'ws'` to a compatibility class, while importing the
 * package entry directly misclassifies a successful HTTP 101 upgrade as
 * `unexpected-response`. Keeping this adapter local makes the transport native
 * without coupling the larger Responses pool to DOM-style events.
 */
export class BunNativeWebSocket extends EventEmitter {
  private readonly socket: WebSocket;
  private failurePending = false;
  private deferredClose: { code: number; reason: string } | undefined;

  constructor(url: string, options: BunWebSocketOptions) {
    super();
    const NativeWebSocket = globalThis.WebSocket as unknown as new (
      target: string,
      config: Bun.WebSocketOptions,
    ) => WebSocket;
    this.socket = new NativeWebSocket(url, {
      headers: options.headers,
      ...(options.proxy ? { proxy: options.proxy } : {}),
      perMessageDeflate: false,
    });
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('open', () => this.emit('open'));
    this.socket.addEventListener('message', event => {
      const data = event.data;
      if (typeof data === 'string') this.emit('message', Buffer.from(data));
      else if (data instanceof ArrayBuffer) this.emit('message', Buffer.from(data));
      else if (ArrayBuffer.isView(data)) {
        this.emit('message', Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      } else {
        this.emit('message', data);
      }
    });
    this.socket.addEventListener('error', event => {
      const candidate = event as ErrorEvent;
      const error = candidate.error instanceof Error
        ? candidate.error
        : new Error(candidate.message || 'Bun WebSocket transport failed');
      if (!candidate.message.includes('Expected 101 status code')) {
        this.emit('error', error);
        return;
      }
      this.failurePending = true;
      void classifyRejectedUpgrade(url, options).then(response => {
        this.failurePending = false;
        if (response && response.status >= 400) {
          const headers = Object.fromEntries(response.headers);
          this.emit('unexpected-response', undefined, {
            statusCode: response.status,
            headers,
            resume() {
              void response.body?.cancel();
            },
          });
          return;
        }
        this.emit('error', error);
        this.emitDeferredClose();
      });
    });
    this.socket.addEventListener('close', event => {
      if (this.failurePending) {
        this.deferredClose = { code: event.code, reason: event.reason };
        return;
      }
      this.emit('close', event.code, Buffer.from(event.reason));
    });
  }

  send(data: string | ArrayBufferLike | ArrayBufferView, callback?: SendCallback): void {
    try {
      this.socket.send(data);
      if (callback) queueMicrotask(() => callback());
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  private emitDeferredClose(): void {
    if (!this.deferredClose) return;
    const { code, reason } = this.deferredClose;
    this.deferredClose = undefined;
    this.emit('close', code, Buffer.from(reason));
  }
}

export function loadBunNativeWebSocket(): typeof BunNativeWebSocket {
  return BunNativeWebSocket;
}

async function classifyRejectedUpgrade(
  wsUrl: string,
  options: BunWebSocketOptions,
): Promise<Response | undefined> {
  const target = new URL(wsUrl);
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  try {
    return await fetch(target, {
      headers: {
        ...options.headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      redirect: 'manual',
      ...(options.proxy ? { proxy: options.proxy } : {}),
    } as RequestInit);
  } catch {
    return undefined;
  }
}
