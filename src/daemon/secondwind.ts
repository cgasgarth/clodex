import { isNumber } from '../runtime/type-guards.js';
import { performance } from 'node:perf_hooks';
import { estimateAnthropicInputTokens } from '../providers/anthropic-endpoints.js';
import { loadPreferences, savePreferences } from '../config/config.js';
import { diagnosticRecord, type InferenceTraceEvent } from '../observability/trace-log.js';
import type { ApiProcessingMode } from './api-pricing.js';
import { estimateApiCost } from './api-pricing.js';
import {
  hashSessionId,
  type SecondwindLifetimeMetrics,
  type SecondwindSavingsEvent,
} from './metrics.js';
import type { SecondwindMode } from '../types.js';
import {
  SecondwindWorkerPool,
  type SecondwindWorkerPoolSnapshot,
} from './secondwind-worker-pool.js';
import type { JsonObject } from '../oauth/responses-websocket/types.js';

const MAX_PENDING_SAVINGS = 2_048;
const MAX_LATENCY_SAMPLES = 10_000;

interface SecondwindRewriteStats {
  blocks_rewritten?: number;
  blocks_first_seen?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_saved?: number;
}

interface SecondwindSession {
  rewrite(request: JsonObject, body?: Uint8Array): {
    request?: JsonObject;
    body?: Uint8Array;
    stats?: SecondwindRewriteStats;
  } | Promise<{
    request?: JsonObject;
    body?: Uint8Array;
    stats?: SecondwindRewriteStats;
  }>;
  close(): void;
}

type SecondwindSessionFactory = (
  key?: string,
) => SecondwindSession | Promise<SecondwindSession>;

export interface SecondwindRewriteRequest {
  requestId?: string;
  body: Buffer;
  request: JsonObject;
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
  observedInputTokens: number;
  savedInputTokens: number;
  savedCachedInputTokens: number;
  savedCacheWriteTokens: number;
  estimatedInputSavingsUsd: number;
  estimatedCacheSavingsUsd: number;
  estimatedOutputSavingsUsd: number;
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
  workers?: SecondwindWorkerPoolSnapshot;
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

interface ObservedRequestSavings {
  observedInputTokens: number;
  savedInputTokens: number;
  savedCachedInputTokens: number;
  savedCacheWriteTokens: number;
  estimatedInputSavingsUsd: number;
  estimatedCacheSavingsUsd: number;
  estimatedOutputSavingsUsd: number;
  estimatedSavingsUsd: number;
}

interface TokenAccounting {
  originalTokens: number;
  optimizedTokens: number;
  tokensReduced: number;
  estimated: boolean;
}

interface SecondwindRewriteResult {
  request?: JsonObject;
  body?: Uint8Array;
  stats?: SecondwindRewriteStats;
}

interface SecondwindServiceOptions {
  initialMode?: SecondwindMode;
  persistMode?: (mode: SecondwindMode) => void;
  createSession?: SecondwindSessionFactory;
  metrics?: SecondwindMetricsPersistence;
  now?: () => number;
  closeBackend?: () => void;
  backendSnapshot?: () => SecondwindWorkerPoolSnapshot;
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
    observedInputTokens: 0,
    savedInputTokens: 0,
    savedCachedInputTokens: 0,
    savedCacheWriteTokens: 0,
    estimatedInputSavingsUsd: 0,
    estimatedCacheSavingsUsd: 0,
    estimatedOutputSavingsUsd: 0,
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
    observedInputTokens: 0,
    savedInputTokens: 0,
    savedCachedInputTokens: 0,
    savedCacheWriteTokens: 0,
    estimatedInputSavingsUsd: 0,
    estimatedCacheSavingsUsd: 0,
    estimatedOutputSavingsUsd: 0,
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

function normalizeSecondwindMode(value: SecondwindMode | undefined): SecondwindMode {
  if (value === 'off' || value === 'shadow') return value;
  return 'on';
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = samples.toSorted((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return isNumber(value) && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function tokenAccounting(
  stats: SecondwindRewriteStats | undefined,
  originalRequest: JsonObject,
  optimizedRequest: () => JsonObject,
  blocksRewritten: number,
): TokenAccounting {
  const measuredInput = nonNegativeInteger(stats?.input_tokens);
  const measuredOutput = nonNegativeInteger(stats?.output_tokens);
  const measuredSaved = nonNegativeInteger(stats?.tokens_saved);
  const blocksFirstSeen = nonNegativeInteger(stats?.blocks_first_seen);
  const measuredStatsCoverRequest = blocksFirstSeen === undefined
    || blocksFirstSeen >= blocksRewritten;

  // Persistent Secondwind sessions report exact token counts only for blocks
  // first seen by that session. A cached resend can still rewrite prior blocks
  // while reporting zero measured tokens, so estimate the complete request in
  // that case instead of silently dropping recurring savings.
  if (measuredSaved !== undefined && measuredStatsCoverRequest) {
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
    ? estimateAnthropicInputTokens(optimizedRequest())
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
    .toSorted((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) {
    const slot = order[index % order.length];
    if (!slot) break;
    distributed[slot.index] = (distributed[slot.index] ?? 0) + 1;
  }
  return distributed;
}

function observedRequestSavings(
  pending: PendingSecondwindSavings,
  usage: SecondwindObservedUsage,
): ObservedRequestSavings | undefined {
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
  const estimatedSavingsUsd = Math.max(0, originalCost.total - optimizedCost.total);
  const positiveComponentDeltas = [
    Math.max(0, originalCost.input - optimizedCost.input),
    Math.max(0, originalCost.cache - optimizedCost.cache),
    Math.max(0, originalCost.output - optimizedCost.output),
  ];
  const positiveTotal = positiveComponentDeltas.reduce((sum, value) => sum + value, 0);
  // A processing-tier or long-context boundary can make one cost component
  // increase while the request still saves overall. Scale positive attribution
  // back to the observed total so the displayed breakdown always reconciles.
  const componentScale = positiveTotal > 0 ? estimatedSavingsUsd / positiveTotal : 0;
  return {
    observedInputTokens: logicalInput,
    savedInputTokens: savedInput,
    savedCachedInputTokens: savedCached,
    savedCacheWriteTokens: savedWrite,
    estimatedInputSavingsUsd: positiveComponentDeltas[0]! * componentScale,
    estimatedCacheSavingsUsd: positiveComponentDeltas[1]! * componentScale,
    estimatedOutputSavingsUsd: positiveComponentDeltas[2]! * componentScale,
    estimatedSavingsUsd,
  };
}

async function defaultCreateSession(): Promise<SecondwindSession> {
  const { Session } = await import('secondwind');
  const session = new Session();
  return {
    rewrite(request) {
      const nativeRequest: Parameters<typeof session.rewrite>[0] = JSON.parse(JSON.stringify(request));
      const result = session.rewrite(nativeRequest);
      return {
        request: diagnosticRecord(result.request),
        stats: result.stats,
      };
    },
    close() {
      session.close();
    },
  };
}

export class SecondwindService {
  readonly #since = new Date().toISOString();
  readonly #persistMode: (mode: SecondwindMode) => void;
  readonly #createSession: SecondwindSessionFactory;
  readonly #now: () => number;
  readonly #closeBackend: () => void;
  readonly #backendSnapshot?: () => SecondwindWorkerPoolSnapshot;
  readonly #activeSessions = new Map<string, number>();
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

  #rememberPendingSavings(requestId: string, pending: PendingSecondwindSavings): void {
    if (this.#pendingSavings.size >= MAX_PENDING_SAVINGS) {
      const oldest = this.#pendingSavings.keys().next().value;
      if (oldest) this.#pendingSavings.delete(oldest);
    }
    this.#pendingSavings.set(requestId, pending);
  }

  constructor(options: SecondwindServiceOptions = {}) {
    this.#mode = normalizeSecondwindMode(options.initialMode);
    this.#persistMode = options.persistMode ?? (() => {});
    this.#createSession = options.createSession ?? defaultCreateSession;
    this.#metrics = options.metrics;
    this.#lifetime = loadLifetimeMetrics(options.metrics);
    this.#now = options.now ?? performance.now.bind(performance);
    this.#closeBackend = options.closeBackend ?? (() => {});
    this.#backendSnapshot = options.backendSnapshot;
  }

  setMode(mode: SecondwindMode): void {
    const normalized = normalizeSecondwindMode(mode);
    this.#persistMode(normalized);
    this.#mode = normalized;
  }

  snapshot(): SecondwindSnapshot {
    const snapshot: SecondwindSnapshot = {
      mode: this.#mode,
      since: this.#since,
      loaded: this.#loaded,
      sessions: this.#activeSessions.size,
      applied: { ...this.#applied },
      shadow: { ...this.#shadow },
      lifetime: { ...this.#lifetime },
      topSessions: [...this.#sessionSavings.values()]
        .toSorted((left, right) =>
          right.tokensReduced - left.tokensReduced
          || right.estimatedSavingsUsd - left.estimatedSavingsUsd
          || left.sessionHash.localeCompare(right.sessionHash))
        .slice(0, 3)
        .map(session => Object.assign({}, session)),
      latency: {
        samples: this.#latencySamples.length,
        medianMs: percentile(this.#latencySamples, 0.5),
        p95Ms: percentile(this.#latencySamples, 0.95),
      },
      errors: this.#errors,
    };
    if (this.#backendSnapshot) snapshot.workers = this.#backendSnapshot();
    if (this.#lastError) snapshot.lastError = this.#lastError;
    return snapshot;
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
    metrics.observedInputTokens += savings.observedInputTokens;
    metrics.savedInputTokens += savings.savedInputTokens;
    metrics.savedCachedInputTokens += savings.savedCachedInputTokens;
    metrics.savedCacheWriteTokens += savings.savedCacheWriteTokens;
    metrics.estimatedInputSavingsUsd += savings.estimatedInputSavingsUsd;
    metrics.estimatedCacheSavingsUsd += savings.estimatedCacheSavingsUsd;
    metrics.estimatedOutputSavingsUsd += savings.estimatedOutputSavingsUsd;
    metrics.estimatedSavingsUsd += savings.estimatedSavingsUsd;
    if (pending.mode !== 'on') return;
    this.#recordAppliedSavings(pending, savings);
  }

  async rewrite(input: SecondwindRewriteRequest): Promise<Buffer> {
    const mode = this.#mode;
    if (mode === 'off') return input.body;

    const startedAt = this.#now();
    const sessionKey = input.sessionId
      ? `${input.modelId}:${input.sessionId}`
      : undefined;
    let session: SecondwindSession | undefined;
    try {
      if (sessionKey) this.#markSessionActive(sessionKey);
      session = await this.#createSession(sessionKey);
      this.#loaded = true;
      const result: SecondwindRewriteResult = await session.rewrite(input.request, input.body);

      const blocksRewritten = Math.max(
        0,
        Math.round(result.stats?.blocks_rewritten ?? 0),
      );
      // Preserve the exact inbound bytes when Secondwind made no change. Besides
      // avoiding needless serialization, this keeps prompt-cache prefixes stable.
      let rewrittenRequest: JsonObject | undefined;
      const readRewrittenRequest = (): JsonObject => {
        if (rewrittenRequest) return rewrittenRequest;
        if (result.request) {
          const request = result.request;
          rewrittenRequest = request;
          return request;
        }
        if (result.body instanceof Uint8Array) {
          const request: JsonObject = JSON.parse(new TextDecoder().decode(result.body));
          rewrittenRequest = request;
          return request;
        }
        throw new Error('Secondwind returned an invalid rewritten request');
      };
      const optimizedBody = blocksRewritten > 0
        ? result.body instanceof Uint8Array
          ? Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength)
          : Buffer.from(JSON.stringify(readRewrittenRequest()))
        : input.body;
      if (input.recordMetrics !== false) {
        const accounting = tokenAccounting(
          result.stats,
          input.request,
          blocksRewritten > 0 ? readRewrittenRequest : () => input.request,
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
          this.#rememberPendingSavings(input.requestId, pending);
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
      session?.close();
      if (sessionKey) this.#markSessionFinished(sessionKey);
      const latencyMs = Math.max(0, this.#now() - startedAt);
      this.#latencySamples.push(latencyMs);
      if (this.#latencySamples.length > MAX_LATENCY_SAMPLES) {
        this.#latencySamples.splice(0, this.#latencySamples.length - MAX_LATENCY_SAMPLES);
      }
    }
  }

  close(): void {
    this.#activeSessions.clear();
    this.#pendingSavings.clear();
    this.#closeBackend();
  }

  #recordAppliedSavings(
    pending: PendingSecondwindSavings,
    savings?: ObservedRequestSavings | number,
  ): void {
    const detail: ObservedRequestSavings = isNumber(savings)
      ? {
          observedInputTokens: 0,
          savedInputTokens: pending.tokensReduced,
          savedCachedInputTokens: 0,
          savedCacheWriteTokens: 0,
          estimatedInputSavingsUsd: savings,
          estimatedCacheSavingsUsd: 0,
          estimatedOutputSavingsUsd: 0,
          estimatedSavingsUsd: savings,
        }
      : savings ?? {
          observedInputTokens: 0,
          savedInputTokens: 0,
          savedCachedInputTokens: 0,
          savedCacheWriteTokens: 0,
          estimatedInputSavingsUsd: 0,
          estimatedCacheSavingsUsd: 0,
          estimatedOutputSavingsUsd: 0,
          estimatedSavingsUsd: 0,
        };
    const event: SecondwindSavingsEvent = {
      requests: 1,
      blocksRewritten: pending.blocksRewritten,
      inputTokensConsidered: pending.originalTokens,
      tokensReduced: pending.tokensReduced,
      estimatedTokenRequests: pending.estimatedTokenRequests,
      ...detail,
    };
    this.#lifetime.requests += event.requests;
    this.#lifetime.blocksRewritten += event.blocksRewritten;
    this.#lifetime.inputTokensConsidered += event.inputTokensConsidered;
    this.#lifetime.tokensReduced += event.tokensReduced;
    this.#lifetime.estimatedTokenRequests += event.estimatedTokenRequests;
    this.#lifetime.estimatedSavingsUsd += event.estimatedSavingsUsd;
    this.#lifetime.observedInputTokens += event.observedInputTokens;
    this.#lifetime.savedInputTokens += event.savedInputTokens;
    this.#lifetime.savedCachedInputTokens += event.savedCachedInputTokens;
    this.#lifetime.savedCacheWriteTokens += event.savedCacheWriteTokens;
    this.#lifetime.estimatedInputSavingsUsd += event.estimatedInputSavingsUsd;
    this.#lifetime.estimatedCacheSavingsUsd += event.estimatedCacheSavingsUsd;
    this.#lifetime.estimatedOutputSavingsUsd += event.estimatedOutputSavingsUsd;
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
    if (savings === undefined) {
      session.unpricedRequests += 1;
    } else {
      session.pricedRequests += 1;
      session.observedInputTokens += detail.observedInputTokens;
      session.savedInputTokens += detail.savedInputTokens;
      session.savedCachedInputTokens += detail.savedCachedInputTokens;
      session.savedCacheWriteTokens += detail.savedCacheWriteTokens;
      session.estimatedInputSavingsUsd += detail.estimatedInputSavingsUsd;
      session.estimatedCacheSavingsUsd += detail.estimatedCacheSavingsUsd;
      session.estimatedOutputSavingsUsd += detail.estimatedOutputSavingsUsd;
      session.estimatedSavingsUsd += detail.estimatedSavingsUsd;
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

  #markSessionActive(key: string): void {
    this.#activeSessions.set(key, (this.#activeSessions.get(key) ?? 0) + 1);
  }

  #markSessionFinished(key: string): void {
    const remaining = (this.#activeSessions.get(key) ?? 1) - 1;
    if (remaining <= 0) this.#activeSessions.delete(key);
    else this.#activeSessions.set(key, remaining);
  }
}

export function createDaemonSecondwindService(
  metrics?: SecondwindMetricsPersistence,
): SecondwindService {
  const workers = new SecondwindWorkerPool();
  return new SecondwindService({
    initialMode: loadPreferences().secondwindMode,
    metrics,
    persistMode: mode => savePreferences({ secondwindMode: mode }),
    createSession: key => {
      return {
        rewrite: async (_request, body) => {
          if (!body) throw new Error('Secondwind worker rewrite requires serialized request bytes');
          const result = await workers.rewrite(key, body);
          return {
            body: result.body,
            stats: result.stats,
          };
        },
        close: () => {},
      };
    },
    closeBackend: () => workers.close(),
    backendSnapshot: () => workers.snapshot(),
  });
}
