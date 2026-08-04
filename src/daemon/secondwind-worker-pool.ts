import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

interface WorkerRewriteStats {
  blocks_rewritten?: number;
  blocks_first_seen?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_saved?: number;
}

export interface WorkerRewriteResult {
  body: Uint8Array;
  stats?: WorkerRewriteStats;
}

export interface SecondwindWorkerPoolSnapshot {
  configured: number;
  running: number;
  pending: number;
  recycled: number;
  failures: number;
  processedBytes: number;
  sessions: number;
  sessionHits: number;
  sessionMisses: number;
  rssBytes: number;
  peakRssBytes: number;
}

type WorkerRequest = {
  type: 'rewrite';
  id: number;
  sessionKey?: string;
  body: Uint8Array;
};

type WorkerCloseRequest = { type: 'close' };

interface WorkerResponse {
  type: 'result';
  id: number;
  body?: Uint8Array;
  stats?: WorkerRewriteStats;
  sessionReused?: boolean;
  sessionCount?: number;
  rssBytes?: number;
  error?: string;
}

interface PendingRewrite {
  resolve: (result: WorkerRewriteResult) => void;
  reject: (error: Error) => void;
}

type WorkerProcess = ReturnType<typeof Bun.spawn>;

interface WorkerSlot {
  process?: WorkerProcess;
  pending: Map<number, PendingRewrite>;
  index: number;
  completed: number;
  processedBytes: number;
  sessions: number;
  rssBytes: number;
  recycling: boolean;
}

export interface SecondwindWorkerPoolOptions {
  workerCount?: number;
  workerUrl?: URL;
  recycleAfterRequests?: number;
  recycleAfterRssBytes?: number;
}

const DEFAULT_RECYCLE_AFTER_REQUESTS = 250;
const DEFAULT_RECYCLE_AFTER_RSS_BYTES = 384 * 1024 * 1024;

function defaultWorkerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./secondwind-worker.${extension}`, import.meta.url);
}

export function secondwindWorkerCount(parallelism = availableParallelism()): number {
  return Math.min(8, Math.max(2, parallelism - 2));
}

export function secondwindWorkerShard(key: string, count: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % count;
}

export class SecondwindWorkerPool {
  private readonly slots: WorkerSlot[];
  private readonly workerUrl: URL;
  private readonly recycleAfterRequests: number;
  private readonly recycleAfterRssBytes: number;
  private nextRequestId = 1;
  private nextEphemeralSlot = 0;
  private closed = false;
  private recycled = 0;
  private failures = 0;
  private processedBytes = 0;
  private sessionHits = 0;
  private sessionMisses = 0;
  private peakRssBytes = 0;

  constructor(options: SecondwindWorkerPoolOptions = {}) {
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
    this.recycleAfterRequests = Math.max(
      1,
      options.recycleAfterRequests ?? DEFAULT_RECYCLE_AFTER_REQUESTS,
    );
    this.recycleAfterRssBytes = Math.max(
      1,
      options.recycleAfterRssBytes ?? DEFAULT_RECYCLE_AFTER_RSS_BYTES,
    );
    const count = Math.max(1, Math.min(16, options.workerCount ?? secondwindWorkerCount()));
    this.slots = Array.from({ length: count }, (_, index) => ({
      pending: new Map(),
      index,
      completed: 0,
      processedBytes: 0,
      sessions: 0,
      rssBytes: 0,
      recycling: false,
    }));
  }

  private createProcess(slot: WorkerSlot): WorkerProcess {
    let child: WorkerProcess;
    child = Bun.spawn({
      cmd: [process.execPath, fileURLToPath(this.workerUrl)],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'inherit',
      ipc: message => this.handleResponse(slot, child, message as WorkerResponse),
      onExit: (_process, exitCode, signalCode, error) => {
        this.handleExit(slot, child, exitCode, signalCode, error);
      },
    });
    return child;
  }

  private handleResponse(
    slot: WorkerSlot,
    child: WorkerProcess,
    response: WorkerResponse,
  ): void {
    if (slot.process !== child) return;
    const pending = slot.pending.get(response.id);
    if (!pending) return;
    slot.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error));
    } else if (response.body) {
      pending.resolve({
        body: new Uint8Array(response.body),
        ...(response.stats ? { stats: response.stats } : {}),
      });
    } else {
      pending.reject(new Error('Secondwind process returned no body'));
    }
    slot.completed += 1;
    slot.processedBytes += response.body?.byteLength ?? 0;
    this.processedBytes += response.body?.byteLength ?? 0;
    slot.sessions = response.sessionCount ?? slot.sessions;
    slot.rssBytes = response.rssBytes ?? slot.rssBytes;
    this.peakRssBytes = Math.max(this.peakRssBytes, slot.rssBytes);
    if (response.sessionReused === true) this.sessionHits += 1;
    else if (response.sessionReused === false) this.sessionMisses += 1;
    this.recycleIfDue(slot);
  }

  private handleExit(
    slot: WorkerSlot,
    child: WorkerProcess,
    exitCode: number | null,
    signalCode: number | null,
    error?: Error,
  ): void {
    if (slot.process !== child) return;
    slot.process = undefined;
    const expected = slot.recycling || this.closed;
    slot.recycling = false;
    slot.completed = 0;
    slot.processedBytes = 0;
    slot.sessions = 0;
    slot.rssBytes = 0;
    if (expected) return;
    this.failures += 1;
    const detail = error?.message
      ?? (signalCode ? `signal ${signalCode}` : `exit ${exitCode ?? 'unknown'}`);
    for (const pending of slot.pending.values()) {
      pending.reject(new Error(`Secondwind process failed (${detail})`));
    }
    slot.pending.clear();
  }

  private recycleIfDue(slot: WorkerSlot): void {
    if (
      slot.pending.size > 0
      || (
        slot.completed < this.recycleAfterRequests
        && slot.rssBytes < this.recycleAfterRssBytes
      )
    ) return;
    this.recycle(slot, true);
  }

  private recycle(slot: WorkerSlot, count = false): void {
    const child = slot.process;
    if (!child) return;
    if (count) this.recycled += 1;
    slot.recycling = true;
    slot.process = undefined;
    try { child.send({ type: 'close' } satisfies WorkerCloseRequest); } catch { /* already closed */ }
    child.kill();
    slot.recycling = false;
    slot.completed = 0;
    slot.processedBytes = 0;
    slot.sessions = 0;
    slot.rssBytes = 0;
  }

  private processFor(slot: WorkerSlot): WorkerProcess {
    if (!slot.process) slot.process = this.createProcess(slot);
    return slot.process;
  }

  rewrite(sessionKey: string | undefined, body: Uint8Array): Promise<WorkerRewriteResult> {
    if (this.closed) return Promise.reject(new Error('Secondwind worker pool is closed'));
    const id = this.nextRequestId++;
    const slotIndex = sessionKey
      ? secondwindWorkerShard(sessionKey, this.slots.length)
      : this.nextEphemeralSlot++ % this.slots.length;
    const slot = this.slots[slotIndex]!;
    const encoded = new Uint8Array(body);
    const message: WorkerRequest = { type: 'rewrite', id, sessionKey, body: encoded };
    slot.processedBytes += encoded.byteLength;
    this.processedBytes += encoded.byteLength;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      try {
        this.processFor(slot).send(message);
      } catch (error) {
        slot.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots) {
      for (const pending of slot.pending.values()) {
        pending.reject(new Error('Secondwind worker pool closed'));
      }
      slot.pending.clear();
      this.recycle(slot);
    }
  }

  snapshot(): SecondwindWorkerPoolSnapshot {
    return {
      configured: this.slots.length,
      running: this.slots.filter(slot => slot.process !== undefined).length,
      pending: this.slots.reduce((total, slot) => total + slot.pending.size, 0),
      recycled: this.recycled,
      failures: this.failures,
      processedBytes: this.processedBytes,
      sessions: this.slots.reduce((total, slot) => total + slot.sessions, 0),
      sessionHits: this.sessionHits,
      sessionMisses: this.sessionMisses,
      rssBytes: this.slots.reduce((total, slot) => total + slot.rssBytes, 0),
      peakRssBytes: this.peakRssBytes,
    };
  }
}
