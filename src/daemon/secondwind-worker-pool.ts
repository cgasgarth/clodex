import { availableParallelism } from 'node:os';

interface WorkerRewriteStats {
  blocks_rewritten?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_saved?: number;
}

export interface WorkerRewriteResult {
  body: Uint8Array;
  stats?: WorkerRewriteStats;
}

type WorkerRequest = {
  type: 'rewrite';
  id: number;
  body: ArrayBuffer;
};

interface WorkerResponse {
  type: 'result';
  id: number;
  body?: ArrayBuffer;
  stats?: WorkerRewriteStats;
  error?: string;
}

interface PendingRewrite {
  resolve: (result: WorkerRewriteResult) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  worker?: Worker;
  pending: Map<number, PendingRewrite>;
  index: number;
  completed: number;
}

export interface SecondwindWorkerPoolOptions {
  workerCount?: number;
  workerUrl?: URL;
  recycleAfterRequests?: number;
  random?: () => number;
}

function defaultWorkerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./secondwind-worker.${extension}`, import.meta.url);
}

export function secondwindWorkerCount(parallelism = availableParallelism()): number {
  return Math.min(8, Math.max(2, parallelism - 2));
}

export class SecondwindWorkerPool {
  private readonly slots: WorkerSlot[];
  private readonly workerUrl: URL;
  private readonly recycleAfterRequests: number;
  private readonly random: () => number;
  private nextRequestId = 1;
  private closed = false;

  constructor(options: SecondwindWorkerPoolOptions = {}) {
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
    this.recycleAfterRequests = Math.max(1, options.recycleAfterRequests ?? 500);
    this.random = options.random ?? Math.random;
    const count = Math.max(1, Math.min(16, options.workerCount ?? secondwindWorkerCount()));
    this.slots = Array.from({ length: count }, (_, index) => {
      return {
        pending: new Map(),
        index,
        completed: 0,
      };
    });
  }

  private createWorker(slot: WorkerSlot): Worker {
    const worker = new Worker(this.workerUrl, { name: `clodex-secondwind-${slot.index}` });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
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
        pending.reject(new Error('Secondwind worker returned no body'));
      }
      slot.completed += 1;
      if (slot.completed >= this.recycleAfterRequests && slot.pending.size === 0) {
        this.recycle(slot);
      }
    };
    worker.onerror = () => {
      for (const pending of slot.pending.values()) {
        pending.reject(new Error('Secondwind worker failed'));
      }
      slot.pending.clear();
      if (!this.closed && slot.worker === worker) this.recycle(slot);
    };
    return worker;
  }

  private recycle(slot: WorkerSlot): void {
    slot.worker?.terminate();
    slot.worker = undefined;
    slot.completed = 0;
  }

  private workerFor(slot: WorkerSlot): Worker {
    if (!slot.worker) slot.worker = this.createWorker(slot);
    return slot.worker;
  }

  rewrite(request: Record<string, unknown>): Promise<WorkerRewriteResult> {
    if (this.closed) return Promise.reject(new Error('Secondwind worker pool is closed'));
    const id = this.nextRequestId++;
    const encoded = new TextEncoder().encode(JSON.stringify(request));
    const sample = Math.max(0, Math.min(1, this.random()));
    const slotIndex = Math.min(this.slots.length - 1, Math.floor(sample * this.slots.length));
    const slot = this.slots[slotIndex]!;
    const message: WorkerRequest & { type: 'rewrite' } = {
      type: 'rewrite',
      id,
      body: encoded.buffer,
    };
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      try {
        this.workerFor(slot).postMessage(message, [message.body]);
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
      slot.worker?.terminate();
      slot.worker = undefined;
    }
  }
}
