import { Writable } from 'node:stream';

type HeaderValue = string | number | readonly string[];
type HeaderRecord = Record<string, HeaderValue>;

/**
 * Writable response bridge for translation code that still emits incremental
 * Anthropic SSE chunks. Bun owns the listener and connection lifecycle; this
 * bridge only converts writes into a web-standard streaming Response.
 */
export class BunHttpResponse extends Writable {
  readonly response: Promise<Response>;
  headersSent = false;

  private readonly headers = new Headers();
  private readonly body: ReadableStream<Uint8Array>;
  private readonly bodyController: ReadableStreamDefaultController<Uint8Array>;
  private resolveResponse!: (response: Response) => void;
  private status = 200;
  private bodyClosed = false;
  private clientCancelled = false;
  private onClientCancel?: () => void;

  constructor() {
    super();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel: () => {
        this.clientCancelled = true;
        this.bodyClosed = true;
        this.onClientCancel?.();
      },
    });
    this.bodyController = controller;
    this.response = new Promise(resolve => {
      this.resolveResponse = resolve;
    });
  }

  setClientCancelHandler(handler: () => void): void {
    this.onClientCancel = handler;
    if (this.clientCancelled) handler();
  }

  setHeader(name: string, value: HeaderValue): this {
    if (this.headersSent) throw new Error('Headers already sent');
    this.headers.delete(name);
    if (Array.isArray(value)) {
      for (const item of value) this.headers.append(name, String(item));
    } else {
      this.headers.set(name, String(value));
    }
    return this;
  }

  writeHead(status: number, headers?: HeaderRecord): this {
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    this.status = status;
    this.commitHeaders();
    return this;
  }

  private commitHeaders(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.resolveResponse(new Response(this.body, {
      status: this.status,
      headers: this.headers,
    }));
  }

  override _write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    // Bun cancels the web stream as soon as the downstream socket closes, but
    // an upstream async iterator may already have yielded its next chunk. Drop
    // that late chunk: surfacing enqueue-on-closed as a Writable error races
    // request cancellation and can crash an otherwise clean disconnect path.
    if (this.clientCancelled || this.bodyClosed) {
      callback();
      return;
    }
    try {
      this.commitHeaders();
      const bytes = typeof chunk === 'string'
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk);
      this.bodyController.enqueue(bytes);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.clientCancelled) {
      callback();
      return;
    }
    try {
      this.commitHeaders();
      if (!this.bodyClosed) {
        this.bodyClosed = true;
        this.bodyController.close();
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      this.commitHeaders();
      if (!this.bodyClosed) {
        this.bodyClosed = true;
        if (error) this.bodyController.error(error);
        else this.bodyController.close();
      }
    } catch {
      // The stream may already have been cancelled by the downstream client.
    }
    callback(error);
  }
}
