import { performance } from 'node:perf_hooks';
import { estimateAnthropicInputTokens } from '../anthropic-endpoints.js';
import { loadPreferences, savePreferences } from '../config.js';
import type { InferenceTraceEvent } from '../trace-log.js';
import type { ApiProcessingMode } from './api-pricing.js';
import { estimateApiCost } from './api-pricing.js';
import {
  hashSessionId,
  type SecondwindLifetimeMetrics,
  type SecondwindSavingsEvent,
} from './metrics.js';
import type { SecondwindMode } from '../types.js';

const MAX_SESSIONS = 256;
const MAX_PENDING_SAVINGS = 2_048;
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
  requestId?: string;
  body: Buffer;
  request: Record<string, unknown>;
  sessionId?: string;
  reportingSessionId?: string;
  modelId: string;
  processingMode?: ApiProcessingMode;
  recordMetrics?: boolean;
}

export interface SecondwindModeMetrics {
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  blocksRewritten: number;
  inputTokensConsidered: number;
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
  lifetime: SecondwindLifetimeMetrics;
  topSessions: SecondwindSessionSavings[];
  latency: {
    samples: number;
    medianMs: number;
    p95Ms: number;
  };
  errors: number;
  lastError?: string;
}

export interface SecondwindSessionSavings extends SecondwindModeMetrics {
  sessionHash: string;
}

interface SecondwindMetricsPersistence {
  secondwindLifetime(): SecondwindLifetimeMetrics;
  appendSecondwindSavings(event: SecondwindSavingsEvent): void;
}

interface SecondwindObservedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

interface PendingSecondwindSavings {
  mode: Exclude<SecondwindMode, 'off'>;
  modelId: string;
  processingMode: ApiProcessingMode;
  originalTokens: number;
  optimizedTokens: number;
  tokensReduced: number;
  blocksRewritten: number;
  estimatedTokenRequests: number;
  sessionHash?: string;
  usage: SecondwindObservedUsage;
}

interface SecondwindServiceOptions {
  initialMode?: unknown;
  persistMode?: (mode: SecondwindMode) => void;
  createSession?: SecondwindSessionFactory;
  metrics?: SecondwindMetricsPersistence;
  now?: () => number;
}

function emptyMetrics(): SecondwindModeMetrics {
  return {
    requests: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    blocksRewritten: 0,
    inputTokensConsidered: 0,
    tokensReduced: 0,
    estimatedTokenRequests: 0,
    estimatedSavingsUsd: 0,
  };
}

function emptyLifetimeMetrics(): SecondwindLifetimeMetrics {
  return {
    requests: 0,
    blocksRewritten: 0,
    inputTokensConsidered: 0,
    tokensReduced: 0,
    estimatedTokenRequests: 0,
    estimatedSavingsUsd: 0,
  };
}

function loadLifetimeMetrics(
  metrics: SecondwindMetricsPersistence | undefined,
): SecondwindLifetimeMetrics {
  if (!metrics) return emptyLifetimeMetrics();
  try {
    return metrics.secondwindLifetime();
  } catch {
    return emptyLifetimeMetrics();
  }
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

function distributeTokens(total: number, weights: number[]): number[] {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || weightTotal <= 0) return weights.map(() => 0);
  const exact = weights.map(weight => total * weight / weightTotal);
  const distributed = exact.map(Math.floor);
  const remainder = total - distributed.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) {
    distributed[order[index % order.length]!.index] += 1;
  }
  return distributed;
}

function observedRequestSavings(
  pending: PendingSecondwindSavings,
  usage: SecondwindObservedUsage,
): number | undefined {
  const weights = [
    Math.max(0, usage.inputTokens),
    Math.max(0, usage.cachedInputTokens),
    Math.max(0, usage.cacheWriteTokens),
  ];
  const logicalInput = weights.reduce((sum, value) => sum + value, 0);
  if (logicalInput <= 0) return undefined;
  const savedTokens = pending.mode === 'shadow'
    ? Math.min(pending.tokensReduced, logicalInput)
    : pending.tokensReduced;
  const [savedInput = 0, savedCached = 0, savedWrite = 0] =
    distributeTokens(savedTokens, weights);
  const actual = {
    modelId: pending.modelId,
    processingMode: pending.processingMode,
    inputTokens: weights[0]!,
    cachedInputTokens: weights[1]!,
    cacheWriteTokens: weights[2]!,
    outputTokens: Math.max(0, usage.outputTokens),
  };
  const original = pending.mode === 'on'
    ? {
        ...actual,
        inputTokens: actual.inputTokens + savedInput,
        cachedInputTokens: actual.cachedInputTokens + savedCached,
        cacheWriteTokens: actual.cacheWriteTokens + savedWrite,
      }
    : actual;
  const optimized = pending.mode === 'shadow'
    ? {
        ...actual,
        inputTokens: actual.inputTokens - savedInput,
        cachedInputTokens: actual.cachedInputTokens - savedCached,
        cacheWriteTokens: actual.cacheWriteTokens - savedWrite,
      }
    : actual;
  const originalCost = estimateApiCost(original);
  const optimizedCost = estimateApiCost(optimized);
  if (!originalCost || !optimizedCost) return undefined;
  return Math.max(0, originalCost.total - optimizedCost.total);
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
  readonly #pendingSavings = new Map<string, PendingSecondwindSavings>();
  readonly #sessionSavings = new Map<string, SecondwindSessionSavings>();
  readonly #latencySamples: number[] = [];
  readonly #applied = emptyMetrics();
  readonly #shadow = emptyMetrics();
  readonly #metrics?: SecondwindMetricsPersistence;
  readonly #lifetime: SecondwindLifetimeMetrics;
  #mode: SecondwindMode;
  #loaded = false;
  #errors = 0;
  #lastError: string | undefined;

  constructor(options: SecondwindServiceOptions = {}) {
    this.#mode = normalizeSecondwindMode(options.initialMode);
    this.#persistMode = options.persistMode ?? (() => {});
    this.#createSession = options.createSession ?? defaultCreateSession;
    this.#metrics = options.metrics;
    this.#lifetime = loadLifetimeMetrics(options.metrics);
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
      lifetime: { ...this.#lifetime },
      topSessions: [...this.#sessionSavings.values()]
        .sort((left, right) =>
          right.tokensReduced - left.tokensReduced
          || right.estimatedSavingsUsd - left.estimatedSavingsUsd
          || left.sessionHash.localeCompare(right.sessionHash))
        .slice(0, 3)
        .map(session => ({ ...session })),
      latency: {
        samples: this.#latencySamples.length,
        medianMs: percentile(this.#latencySamples, 0.5),
        p95Ms: percentile(this.#latencySamples, 0.95),
      },
      errors: this.#errors,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  handleTrace(event: InferenceTraceEvent): void {
    if (event.kind !== 'lifecycle') return;
    const entry = event.entry;
    const pending = this.#pendingSavings.get(entry.requestId);
    if (!pending) return;
    pending.usage.inputTokens = Math.max(
      pending.usage.inputTokens,
      entry.inputTokens ?? 0,
    );
    pending.usage.cachedInputTokens = Math.max(
      pending.usage.cachedInputTokens,
      entry.cacheReadInputTokens ?? 0,
    );
    pending.usage.cacheWriteTokens = Math.max(
      pending.usage.cacheWriteTokens,
      entry.cacheCreationInputTokens ?? 0,
    );
    pending.usage.outputTokens = Math.max(
      pending.usage.outputTokens,
      entry.outputTokens ?? 0,
    );
    if (
      entry.event !== 'response_completed'
      && entry.event !== 'response_failed'
      && entry.event !== 'response_client_disconnected'
    ) return;
    this.#pendingSavings.delete(entry.requestId);
    const savings = observedRequestSavings(pending, pending.usage);
    const metrics = pending.mode === 'on' ? this.#applied : this.#shadow;
    if (savings === undefined) {
      metrics.unpricedRequests += 1;
      if (pending.mode === 'on') this.#recordAppliedSavings(pending);
      return;
    }
    metrics.pricedRequests += 1;
    metrics.estimatedSavingsUsd += savings;
    if (pending.mode !== 'on') return;
    this.#recordAppliedSavings(pending, savings);
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
        metrics.inputTokensConsidered += accounting.originalTokens;
        metrics.tokensReduced += accounting.tokensReduced;
        if (accounting.estimated) metrics.estimatedTokenRequests += 1;
        const processingMode = input.processingMode ?? 'standard';
        const sessionHash = hashSessionId(
          input.reportingSessionId ?? input.sessionId,
        );
        const pending: PendingSecondwindSavings = {
          mode,
          modelId: input.modelId,
          processingMode,
          originalTokens: accounting.originalTokens,
          optimizedTokens: accounting.optimizedTokens,
          tokensReduced: accounting.tokensReduced,
          blocksRewritten,
          estimatedTokenRequests: accounting.estimated ? 1 : 0,
          sessionHash,
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
          },
        };
        let immediateSavingsUsd: number | undefined;
        if (input.requestId) {
          if (this.#pendingSavings.size >= MAX_PENDING_SAVINGS) {
            const oldest = this.#pendingSavings.keys().next().value as string | undefined;
            if (oldest) this.#pendingSavings.delete(oldest);
          }
          this.#pendingSavings.set(input.requestId, pending);
        } else {
          immediateSavingsUsd = estimatedInputSavings(
            input.modelId,
            processingMode,
            accounting.originalTokens,
            accounting.optimizedTokens,
          );
          if (immediateSavingsUsd === undefined) {
            metrics.unpricedRequests += 1;
          } else {
            metrics.pricedRequests += 1;
            metrics.estimatedSavingsUsd += immediateSavingsUsd;
          }
        }
        if (mode === 'on' && !input.requestId) {
          this.#recordAppliedSavings(pending, immediateSavingsUsd);
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
    this.#pendingSavings.clear();
  }

  #recordAppliedSavings(
    pending: PendingSecondwindSavings,
    estimatedSavingsUsd?: number,
  ): void {
    const event: SecondwindSavingsEvent = {
      requests: 1,
      blocksRewritten: pending.blocksRewritten,
      inputTokensConsidered: pending.originalTokens,
      tokensReduced: pending.tokensReduced,
      estimatedTokenRequests: pending.estimatedTokenRequests,
      estimatedSavingsUsd: estimatedSavingsUsd ?? 0,
    };
    this.#lifetime.requests += event.requests;
    this.#lifetime.blocksRewritten += event.blocksRewritten;
    this.#lifetime.inputTokensConsidered += event.inputTokensConsidered;
    this.#lifetime.tokensReduced += event.tokensReduced;
    this.#lifetime.estimatedTokenRequests += event.estimatedTokenRequests;
    this.#lifetime.estimatedSavingsUsd += event.estimatedSavingsUsd;
    this.#persistLifetime(event);

    if (!pending.sessionHash) return;
    const session = this.#sessionSavings.get(pending.sessionHash) ?? {
      sessionHash: pending.sessionHash,
      ...emptyMetrics(),
    };
    session.requests += 1;
    session.blocksRewritten += event.blocksRewritten;
    session.inputTokensConsidered += event.inputTokensConsidered;
    session.tokensReduced += event.tokensReduced;
    session.estimatedTokenRequests += event.estimatedTokenRequests;
    if (estimatedSavingsUsd === undefined) {
      session.unpricedRequests += 1;
    } else {
      session.pricedRequests += 1;
      session.estimatedSavingsUsd += estimatedSavingsUsd;
    }
    this.#sessionSavings.set(pending.sessionHash, session);
  }

  #persistLifetime(event: SecondwindSavingsEvent): void {
    try {
      this.#metrics?.appendSecondwindSavings(event);
    } catch {
      // Metrics persistence must never alter inference behavior.
    }
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

export function createDaemonSecondwindService(
  metrics?: SecondwindMetricsPersistence,
): SecondwindService {
  return new SecondwindService({
    initialMode: loadPreferences().secondwindMode,
    metrics,
    persistMode: mode => savePreferences({ secondwindMode: mode }),
  });
}
