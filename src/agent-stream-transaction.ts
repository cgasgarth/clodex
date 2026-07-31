import type { ServerResponse } from 'node:http';

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface AgentStreamTransactionOptions {
  enabled: boolean;
  commitChunk: (chunk: string) => void;
  maxBufferBytes?: number;
  onBufferLimitExceeded?: (bufferedBytes: number) => void;
}

/**
 * Holds child-agent output behind a transaction boundary until the upstream
 * response completes. Until commit(), a transient provider failure can discard
 * the attempt and replay it without duplicating text or tool calls in Claude.
 */
export class AgentStreamTransaction {
  readonly enabled: boolean;
  private readonly commitChunk: (chunk: string) => void;
  private readonly maxBufferBytes: number;
  private readonly onBufferLimitExceeded?: (bufferedBytes: number) => void;
  private chunks: string[] = [];
  private bytes = 0;
  private committed = false;

  constructor(options: AgentStreamTransactionOptions) {
    this.enabled = options.enabled;
    this.commitChunk = options.commitChunk;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.onBufferLimitExceeded = options.onBufferLimitExceeded;
  }

  get replaySafe(): boolean {
    return !this.committed;
  }

  write(chunk: string): void {
    if (!this.enabled || this.committed) {
      this.committed = true;
      this.commitChunk(chunk);
      return;
    }

    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes <= this.maxBufferBytes) return;

    this.onBufferLimitExceeded?.(this.bytes);
    this.commit();
  }

  /** Release one complete response to Claude in its original chunk order. */
  commit(): void {
    if (this.committed) return;
    this.committed = true;
    const chunks = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    for (const chunk of chunks) this.commitChunk(chunk);
  }

  /** Discard an uncommitted failed attempt before a safe replay. */
  discard(): number | undefined {
    if (!this.replaySafe) return undefined;
    const discardedBytes = this.bytes;
    this.chunks = [];
    this.bytes = 0;
    return discardedBytes;
  }
}

interface CreateAgentStreamTransactionOptions {
  enabled: boolean;
  response: Pick<ServerResponse, 'headersSent' | 'writeHead' | 'write'>;
  onOutput: (chunk: string) => void;
  onBufferLimitExceeded: (bufferedBytes: number) => void;
}

export function createAgentStreamTransaction(options: CreateAgentStreamTransactionOptions): {
  transaction: AgentStreamTransaction;
  ensureHeaders: () => void;
} {
  const ensureHeaders = () => {
    if (options.response.headersSent) return;
    options.response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  };
  const transaction = new AgentStreamTransaction({
    enabled: options.enabled,
    commitChunk: chunk => {
      options.onOutput(chunk);
      ensureHeaders();
      options.response.write(chunk);
    },
    onBufferLimitExceeded: options.onBufferLimitExceeded,
  });
  return { transaction, ensureHeaders };
}

export const CHILD_AGENT_STREAM_MAX_RETRIES = 2;

export function childAgentRetryDelayMs(retryNumber: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return retryAfterSeconds * 1_000;
  const boundedRetry = Math.max(1, Math.min(retryNumber, CHILD_AGENT_STREAM_MAX_RETRIES));
  return 250 * (2 ** (boundedRetry - 1));
}

export function shouldRetryChildAgentStream(
  transaction: AgentStreamTransaction,
  retryable: boolean,
  retryCount: number,
): boolean {
  return transaction.enabled && transaction.replaySafe && retryable
    && retryCount < CHILD_AGENT_STREAM_MAX_RETRIES;
}

/** Wait for retry backoff, resolving false immediately when Claude disconnects. */
export function waitForChildAgentRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
