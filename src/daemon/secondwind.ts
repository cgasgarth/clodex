import { performance } from 'node:perf_hooks';
import { estimateAnthropicInputTokens } from '../anthropic-endpoints.js';
import { loadPreferences, savePreferences } from '../config.js';
import type { ApiProcessingMode } from './api-pricing.js';
import { estimateApiCost } from './api-pricing.js';
import type { SecondwindMode } from '../types.js';

const MAX_SESSIONS = 256;
const MAX_LATENCY_SAMPLES = 10_000;

interface SecondwindRewriteStats {
  blocks_rewritten?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_saved?: number;
}

interface SecondwindSession {
  rewrite(request: Record<string, unknown>): {
    request: Record<string, unknown>;
    stats?: SecondwindRewriteStats;
  };
  close(): void;
}

type SecondwindSessionFactory = () => Promise<SecondwindSession>;

export interface SecondwindRewriteRequest {
  body: Buffer;
  request: Record<string, unknown>;
  sessionId?: string;
  modelId: string;
  processingMode?: ApiProcessingMode;
  recordMetrics?: boolean;
}

export interface SecondwindModeMetrics {
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  blocksRewritten: number;
  tokensReduced: number;
  estimatedTokenRequests: number;
  estimatedSavingsUsd: number;
}

export interface SecondwindSnapshot {
  mode: SecondwindMode;
  since: string;
  loaded: boolean;
  sessions: number;
  applied: SecondwindModeMetrics;
  shadow: SecondwindModeMetrics;
  latency: {
    samples: number;
    medianMs: number;
    p95Ms: number;
  };
  errors: number;
  lastError?: string;
}

interface SecondwindServiceOptions {
  initialMode?: unknown;
  persistMode?: (mode: SecondwindMode) => void;
  createSession?: SecondwindSessionFactory;
  now?: () => number;
}

function emptyMetrics(): SecondwindModeMetrics {
  return {
    requests: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    blocksRewritten: 0,
    tokensReduced: 0,
    estimatedTokenRequests: 0,
    estimatedSavingsUsd: 0,
  };
}

export function normalizeSecondwindMode(value: unknown): SecondwindMode {
  return value === 'on' || value === 'shadow' ? value : 'off';
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function tokenAccounting(
  stats: SecondwindRewriteStats | undefined,
  originalRequest: Record<string, unknown>,
  optimizedRequest: Record<string, unknown>,
  blocksRewritten: number,
): {
  originalTokens: number;
  optimizedTokens: number;
  tokensReduced: number;
  estimated: boolean;
} {
  const measuredInput = nonNegativeInteger(stats?.input_tokens);
  const measuredOutput = nonNegativeInteger(stats?.output_tokens);
  const measuredSaved = nonNegativeInteger(stats?.tokens_saved);

  if (measuredSaved !== undefined) {
    if (measuredInput !== undefined && measuredOutput !== undefined) {
      return {
        originalTokens: measuredInput,
        optimizedTokens: measuredOutput,
        tokensReduced: measuredSaved,
        estimated: false,
      };
    }
    const estimatedInput = estimateAnthropicInputTokens(originalRequest);
    const originalTokens = measuredInput
      ?? (measuredOutput !== undefined ? measuredOutput + measuredSaved : estimatedInput);
    const optimizedTokens = measuredOutput
      ?? Math.max(0, originalTokens - measuredSaved);
    return {
      originalTokens,
      optimizedTokens,
      tokensReduced: measuredSaved,
      estimated: false,
    };
  }

  const estimatedInput = estimateAnthropicInputTokens(originalRequest);
  const estimatedOutput = blocksRewritten > 0
    ? estimateAnthropicInputTokens(optimizedRequest)
    : estimatedInput;
  return {
    originalTokens: estimatedInput,
    optimizedTokens: estimatedOutput,
    tokensReduced: Math.max(0, estimatedInput - estimatedOutput),
    estimated: true,
  };
}

function estimatedInputSavings(
  modelId: string,
  processingMode: ApiProcessingMode,
  originalTokens: number,
  optimizedTokens: number,
): number | undefined {
  const original = estimateApiCost({
    modelId,
    processingMode,
    inputTokens: originalTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  });
  const optimized = estimateApiCost({
    modelId,
    processingMode,
    inputTokens: optimizedTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  });
  if (!original || !optimized) return undefined;
  return Math.max(0, original.total - optimized.total);
}

async function defaultCreateSession(): Promise<SecondwindSession> {
  const { Session } = await import('secondwind');
  return new Session();
}

export class SecondwindService {
  readonly #since = new Date().toISOString();
  readonly #persistMode: (mode: SecondwindMode) => void;
  readonly #createSession: SecondwindSessionFactory;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SecondwindSession>();
  readonly #pendingSessions = new Map<string, Promise<SecondwindSession>>();
  readonly #latencySamples: number[] = [];
  readonly #applied = emptyMetrics();
  readonly #shadow = emptyMetrics();
  #mode: SecondwindMode;
  #loaded = false;
  #errors = 0;
  #lastError: string | undefined;

  constructor(options: SecondwindServiceOptions = {}) {
    this.#mode = normalizeSecondwindMode(options.initialMode);
    this.#persistMode = options.persistMode ?? (() => {});
    this.#createSession = options.createSession ?? defaultCreateSession;
    this.#now = options.now ?? performance.now.bind(performance);
  }

  setMode(mode: SecondwindMode): void {
    const normalized = normalizeSecondwindMode(mode);
    this.#persistMode(normalized);
    this.#mode = normalized;
  }

  snapshot(): SecondwindSnapshot {
    return {
      mode: this.#mode,
      since: this.#since,
      loaded: this.#loaded,
      sessions: this.#sessions.size,
      applied: { ...this.#applied },
      shadow: { ...this.#shadow },
      latency: {
        samples: this.#latencySamples.length,
        medianMs: percentile(this.#latencySamples, 0.5),
        p95Ms: percentile(this.#latencySamples, 0.95),
      },
      errors: this.#errors,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  async rewrite(input: SecondwindRewriteRequest): Promise<Buffer> {
    const mode = this.#mode;
    if (mode === 'off') return input.body;

    const startedAt = this.#now();
    let ephemeral: SecondwindSession | undefined;
    try {
      const session = input.sessionId
        ? await this.#sessionFor(`${input.modelId}:${input.sessionId}`)
        : (ephemeral = await this.#createSession());
      this.#loaded = true;
      const result = session.rewrite(input.request);
      if (!result?.request || typeof result.request !== 'object') {
        throw new Error('Secondwind returned an invalid rewritten request');
      }

      const blocksRewritten = Math.max(
        0,
        Math.round(result.stats?.blocks_rewritten ?? 0),
      );
      // Preserve the exact inbound bytes when Secondwind made no change. Besides
      // avoiding needless serialization, this keeps prompt-cache prefixes stable.
      const optimizedBody = blocksRewritten > 0
        ? Buffer.from(JSON.stringify(result.request))
        : input.body;
      if (input.recordMetrics !== false) {
        const accounting = tokenAccounting(
          result.stats,
          input.request,
          result.request,
          blocksRewritten,
        );
        const metrics = mode === 'on' ? this.#applied : this.#shadow;
        metrics.requests += 1;
        metrics.blocksRewritten += blocksRewritten;
        metrics.tokensReduced += accounting.tokensReduced;
        if (accounting.estimated) metrics.estimatedTokenRequests += 1;
        const estimatedSavingsUsd = estimatedInputSavings(
          input.modelId,
          input.processingMode ?? 'standard',
          accounting.originalTokens,
          accounting.optimizedTokens,
        );
        if (estimatedSavingsUsd === undefined) {
          metrics.unpricedRequests += 1;
        } else {
          metrics.pricedRequests += 1;
          metrics.estimatedSavingsUsd += estimatedSavingsUsd;
        }
      }
      this.#lastError = undefined;
      return mode === 'on' ? optimizedBody : input.body;
    } catch (error) {
      this.#errors += 1;
      this.#lastError = error instanceof Error ? error.message : String(error);
      return input.body;
    } finally {
      ephemeral?.close();
      const latencyMs = Math.max(0, this.#now() - startedAt);
      this.#latencySamples.push(latencyMs);
      if (this.#latencySamples.length > MAX_LATENCY_SAMPLES) {
        this.#latencySamples.splice(0, this.#latencySamples.length - MAX_LATENCY_SAMPLES);
      }
    }
  }

  close(): void {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }

  async #sessionFor(key: string): Promise<SecondwindSession> {
    const existing = this.#sessions.get(key);
    if (existing) {
      this.#sessions.delete(key);
      this.#sessions.set(key, existing);
      return existing;
    }
    const pending = this.#pendingSessions.get(key);
    if (pending) return pending;
    const creation = this.#createSession();
    this.#pendingSessions.set(key, creation);
    let created: SecondwindSession;
    try {
      created = await creation;
    } finally {
      this.#pendingSessions.delete(key);
    }
    this.#sessions.set(key, created);
    if (this.#sessions.size > MAX_SESSIONS) {
      const oldestKey = this.#sessions.keys().next().value as string | undefined;
      if (oldestKey) {
        const oldest = this.#sessions.get(oldestKey);
        this.#sessions.delete(oldestKey);
        oldest?.close();
      }
    }
    return created;
  }
}

export function createDaemonSecondwindService(): SecondwindService {
  return new SecondwindService({
    initialMode: loadPreferences().secondwindMode,
    persistMode: mode => savePreferences({ secondwindMode: mode }),
  });
}
