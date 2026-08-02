import { createHash } from 'node:crypto';
import { IMAGE_INPUT_TOKEN_ESTIMATE } from '../anthropic-endpoints.js';
import {
  compactResponsesWindow,
  RESPONSES_COMPACT_TIMEOUT_MS,
  ResponsesCompactionError,
  type ResponsesCompactionUsage,
} from './responses-compaction.js';

type JsonObject = Record<string, unknown>;

const MODEL_OUTPUT_KINDS = new Set([
  'reasoning',
  'message',
  'function_call',
  'custom_tool_call',
  'computer_call',
  'local_shell_call',
  'web_search_call',
  'file_search_call',
  'code_interpreter_call',
  'image_generation_call',
]);

const TOOL_OUTPUT_KINDS = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'computer_call_output',
  'local_shell_call_output',
]);

type OverflowRecoverySourceKind = 'live_head' | 'checkpoint' | 'inferred';
export type OverflowRecoveryReason =
  | 'known_oversized'
  | 'compact_context_rejection'
  | 'response_context_rejection';

const DEFAULT_MAX_COMPACT_CALLS = 8;
const DEFAULT_MAX_CONTEXT_REJECTIONS = 2;
const DEFAULT_RECOVERY_DEADLINE_MS = 30 * 60_000;
const DEFAULT_FINAL_CREATE_RESERVE_MS = 5 * 60_000;
const REJECTED_DIAGNOSTIC_LIMIT = 16;

export interface OverflowRecoverySource {
  kind: Exclude<OverflowRecoverySourceKind, 'inferred'>;
  prefix: unknown[];
  tail: unknown[];
  /** Provider-reported input tokens for the accepted prefix when available. */
  prefixInputTokens?: number;
}

export interface OverflowRecoveryCandidate {
  source: OverflowRecoverySourceKind;
  prefix: unknown[];
  tail: unknown[];
  prefixFingerprint: string;
  tailFingerprint: string;
  estimatedPrefixTokens: number;
  estimatedTailTokens: number;
}

export interface PlanResponsesOverflowRecoveryOptions {
  fullInput: unknown[];
  sources?: OverflowRecoverySource[];
  compactThreshold: number;
  contextWindow: number;
  estimatedInputTokens?: number;
  maxCandidates?: number;
}

export interface ResponsesOverflowRecoveryPlan {
  candidates: OverflowRecoveryCandidate[];
  rejected: Array<{
    source: OverflowRecoverySourceKind;
    reason: string;
  }>;
}

interface ProgressiveOverflowRecoveryStep {
  input: unknown[];
  estimatedInputTokens: number;
}

interface ProgressiveOverflowRecoveryPlanEvent {
  stage: number;
  inputItems: number;
  estimatedInputTokens?: number;
  plan: ResponsesOverflowRecoveryPlan;
}

interface ProgressiveOverflowRecoveryAcceptedEvent {
  stage: number;
  previousInputItems: number;
  inputItems: number;
  previousEstimatedInputTokens?: number;
  estimatedInputTokens: number;
}

export interface ProgressiveOverflowRecoveryOptions {
  fullInput: unknown[];
  sources?: OverflowRecoverySource[];
  compactThreshold: number;
  contextWindow: number;
  estimatedInputTokens?: number;
  forceInitialCompaction?: boolean;
  maxStages?: number;
  maxCandidatesPerStage?: number;
  compactCandidate: (
    candidate: OverflowRecoveryCandidate,
    stage: number,
  ) => Promise<ProgressiveOverflowRecoveryStep | undefined>;
  onPlan?: (event: ProgressiveOverflowRecoveryPlanEvent) => void;
  onAccepted?: (event: ProgressiveOverflowRecoveryAcceptedEvent) => void;
}

export interface ProgressiveOverflowRecoveryResult {
  recovered: boolean;
  input: unknown[];
  estimatedInputTokens?: number;
  stages: number;
  reason:
    | 'target_reached'
    | 'no_dependency_safe_prefix'
    | 'non_monotonic_progress'
    | 'maximum_compaction_stages';
}

export type OverflowCompactionClaim =
  | { ok: true; attempt: number; timeoutMs: number }
  | { ok: false; reason: 'compact_call_limit' | 'context_rejection_limit' | 'deadline' };

export type OverflowFinalCreateAdmission =
  | { ok: true; remainingMs: number }
  | { ok: false; reason: 'deadline' | 'final_create_reserve'; remainingMs: number };

export interface ResponsesOverflowRecoverySessionOptions {
  requestUrl: string | URL | Request;
  headers: HeadersInit | undefined;
  payload: JsonObject;
  compactThreshold: number;
  contextWindow: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  compactTimeoutMs?: number;
  maxCompactCalls?: number;
  maxContextRejections?: number;
  deadlineMs?: number;
  finalCreateReserveMs?: number;
  now?: () => number;
  onDiagnostic?: (event: Record<string, unknown>) => void;
}

export interface ResponsesOverflowRecoveryRequest {
  reason: OverflowRecoveryReason;
  input: unknown[];
  sources?: OverflowRecoverySource[];
  estimatedInputTokens?: number;
  forceInitialCompaction?: boolean;
}

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function responsesItemKind(value: unknown): string {
  const item = record(value);
  if (!item) return typeof value;
  if (typeof item.type === 'string') return item.type;
  if (typeof item.role === 'string') return item.role;
  return 'object';
}

function isAssistantMessage(value: unknown): boolean {
  const item = record(value);
  return responsesItemKind(value) === 'message' && item?.role !== 'user';
}

function isModelOutput(value: unknown): boolean {
  const kind = responsesItemKind(value);
  return (MODEL_OUTPUT_KINDS.has(kind) || kind.endsWith('_call'))
    && (kind !== 'message' || isAssistantMessage(value));
}

function callId(value: unknown): string | undefined {
  const item = record(value);
  const valueId = item?.call_id;
  return typeof valueId === 'string' && valueId.length > 0 ? valueId : undefined;
}

function itemFingerprint(items: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
}

function approximateItemTokens(value: unknown): number {
  let imageCount = 0;
  const rawSerialized: unknown = JSON.stringify(value, (_key, nested: unknown) => {
    const item = record(nested);
    if (item?.type === 'input_image' || item?.type === 'input_audio') {
      imageCount += 1;
      return { type: item.type };
    }
    return nested;
  });
  const serialized = typeof rawSerialized === 'string' ? rawSerialized : '';
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4))
    + imageCount * IMAGE_INPUT_TOKEN_ESTIMATE;
}

export function approximateResponsesItemsTokens(items: unknown[]): number {
  return items.reduce<number>((total, item) => total + approximateItemTokens(item), 0);
}

function fixedPromptTokens(fullInput: unknown[], estimatedInputTokens?: number): number {
  if (estimatedInputTokens === undefined) return 0;
  return Math.max(0, estimatedInputTokens - approximateResponsesItemsTokens(fullInput));
}

function estimatedRequestTokens(
  items: unknown[],
  fullInput: unknown[],
  estimatedInputTokens?: number,
): number {
  return fixedPromptTokens(fullInput, estimatedInputTokens)
    + approximateResponsesItemsTokens(items);
}

function dependencyViolation(
  prefix: unknown[],
  tail: unknown[],
  trustAcceptedPrefix: boolean,
): string | undefined {
  const prefixCalls = new Set<string>();
  const prefixOutputs = new Set<string>();
  const tailCalls = new Set<string>();
  const tailOutputs = new Set<string>();

  const collect = (items: unknown[], calls: Set<string>, outputs: Set<string>) => {
    for (const item of items) {
      const kind = responsesItemKind(item);
      const id = callId(item);
      if (!id) continue;
      if (kind.endsWith('_call') || kind === 'function_call' || kind === 'custom_tool_call') {
        calls.add(id);
      }
      if (TOOL_OUTPUT_KINDS.has(kind) || kind.endsWith('_call_output')) outputs.add(id);
    }
  };
  collect(prefix, prefixCalls, prefixOutputs);
  collect(tail, tailCalls, tailOutputs);

  for (const id of tailOutputs) {
    if (prefixCalls.has(id)) return 'tool_dependency_crosses_cut';
    if (!tailCalls.has(id)) return 'tail_tool_output_has_no_tail_producer';
  }
  for (const id of prefixCalls) {
    if (tailOutputs.has(id)) return 'tool_dependency_crosses_cut';
  }
  if (!trustAcceptedPrefix) {
    for (const id of prefixOutputs) {
      if (!prefixCalls.has(id)) return 'prefix_tool_output_has_no_prefix_producer';
    }
  }
  return undefined;
}

function inferredBoundaries(input: unknown[]): number[] {
  const starts: number[] = [];
  let inOutputGroup = false;
  for (let index = 0; index < input.length; index += 1) {
    const output = isModelOutput(input[index]);
    if (output && !inOutputGroup && index > 0) starts.push(index);
    inOutputGroup = output;
  }
  return starts.reverse();
}

function sourceCandidates(
  fullInput: unknown[],
  sources: OverflowRecoverySource[],
): Array<{
  source: OverflowRecoverySourceKind;
  prefix: unknown[];
  tail: unknown[];
  prefixInputTokens?: number;
}> {
  const candidates: Array<{
    source: OverflowRecoverySourceKind;
    prefix: unknown[];
    tail: unknown[];
    prefixInputTokens?: number;
  }> = sources.map(source => ({
    source: source.kind,
    prefix: source.prefix,
    tail: source.tail,
    prefixInputTokens: source.prefixInputTokens,
  }));
  for (const cut of inferredBoundaries(fullInput)) {
    candidates.push({
      source: 'inferred',
      prefix: fullInput.slice(0, cut),
      tail: fullInput.slice(cut),
    });
  }
  return candidates;
}

/**
 * Produce newest-first, content-preserving prefix-compaction candidates.
 *
 * The planner never mutates or truncates an item. It prefers exact live or
 * checkpoint boundaries, then falls back to complete model-output boundaries
 * inferred from the translated Responses input.
 */
export function planResponsesOverflowRecovery(
  options: PlanResponsesOverflowRecoveryOptions,
): ResponsesOverflowRecoveryPlan {
  const candidates: OverflowRecoveryCandidate[] = [];
  const rejected: ResponsesOverflowRecoveryPlan['rejected'] = [];
  const seen = new Set<string>();
  const maxCandidates = Math.max(1, options.maxCandidates ?? 2);

  for (const candidate of sourceCandidates(options.fullInput, options.sources ?? [])) {
    if (candidates.length >= maxCandidates) break;
    if (candidate.prefix.length === 0 || candidate.tail.length === 0) {
      rejected.push({ source: candidate.source, reason: 'empty_prefix_or_tail' });
      continue;
    }
    const prefixFingerprint = itemFingerprint(candidate.prefix);
    if (seen.has(prefixFingerprint)) continue;
    seen.add(prefixFingerprint);

    const violation = dependencyViolation(
      candidate.prefix,
      candidate.tail,
      candidate.source !== 'inferred',
    );
    if (violation) {
      rejected.push({ source: candidate.source, reason: violation });
      continue;
    }

    const estimatedPrefixTokens = candidate.prefixInputTokens
      ?? estimatedRequestTokens(
        candidate.prefix,
        options.fullInput,
        options.estimatedInputTokens,
      );
    if (estimatedPrefixTokens > options.compactThreshold) {
      rejected.push({ source: candidate.source, reason: 'prefix_exceeds_compact_threshold' });
      continue;
    }
    const estimatedTailTokens = estimatedRequestTokens(
      candidate.tail,
      options.fullInput,
      options.estimatedInputTokens,
    );
    if (estimatedTailTokens >= options.contextWindow) {
      rejected.push({ source: candidate.source, reason: 'tail_exceeds_context_window' });
      continue;
    }

    candidates.push({
      source: candidate.source,
      prefix: candidate.prefix,
      tail: candidate.tail,
      prefixFingerprint,
      tailFingerprint: itemFingerprint(candidate.tail),
      estimatedPrefixTokens,
      estimatedTailTokens,
    });
  }

  return { candidates, rejected };
}

export function estimatedRebasedInputTokens(
  compactedOutput: unknown[],
  tail: unknown[],
  fullInput: unknown[],
  estimatedInputTokens: number | undefined,
  compactOutputTokens?: number,
): number {
  const compactTokens = compactOutputTokens
    ?? approximateResponsesItemsTokens(compactedOutput);
  return fixedPromptTokens(fullInput, estimatedInputTokens)
    + compactTokens
    + approximateResponsesItemsTokens(tail);
}

/**
 * Repeatedly fold dependency-closed prefixes into canonical compact output.
 * Each stage plans from the previous stage's rebase, never the original input.
 */
export async function runProgressiveOverflowRecovery(
  options: ProgressiveOverflowRecoveryOptions,
): Promise<ProgressiveOverflowRecoveryResult> {
  let input = options.fullInput;
  let estimatedInputTokens = options.estimatedInputTokens;
  let sources = options.sources ?? [];
  let madeProgress = false;
  const maxStages = Math.max(1, options.maxStages ?? 8);
  const maxCandidates = Math.max(1, options.maxCandidatesPerStage ?? 4);

  for (let stage = 1; stage <= maxStages; stage += 1) {
    if (
      estimatedInputTokens !== undefined
      && estimatedInputTokens <= options.compactThreshold
      && (madeProgress || !options.forceInitialCompaction)
    ) {
      return { recovered: madeProgress, input, estimatedInputTokens, stages: stage - 1, reason: 'target_reached' };
    }
    const beforeEstimate = estimatedInputTokens;
    const plan = planResponsesOverflowRecovery({
      fullInput: input,
      sources,
      compactThreshold: options.compactThreshold,
      contextWindow: options.contextWindow,
      estimatedInputTokens,
      maxCandidates,
    });
    sources = [];
    options.onPlan?.({ stage, inputItems: input.length, estimatedInputTokens, plan });

    let step: ProgressiveOverflowRecoveryStep | undefined;
    for (const candidate of plan.candidates) {
      step = await options.compactCandidate(candidate, stage);
      if (step) break;
    }
    if (!step) {
      return {
        recovered: false,
        input,
        estimatedInputTokens,
        stages: stage - 1,
        reason: 'no_dependency_safe_prefix',
      };
    }
    if (
      beforeEstimate !== undefined
      && step.estimatedInputTokens >= beforeEstimate
    ) {
      return {
        recovered: false,
        input: step.input,
        estimatedInputTokens: step.estimatedInputTokens,
        stages: stage,
        reason: 'non_monotonic_progress',
      };
    }
    const previousInputItems = input.length;
    input = step.input;
    estimatedInputTokens = step.estimatedInputTokens;
    madeProgress = true;
    options.onAccepted?.({
      stage,
      previousInputItems,
      inputItems: input.length,
      previousEstimatedInputTokens: beforeEstimate,
      estimatedInputTokens,
    });
    if (estimatedInputTokens <= options.compactThreshold) {
      return { recovered: true, input, estimatedInputTokens, stages: stage, reason: 'target_reached' };
    }
  }

  return {
    recovered: false,
    input,
    estimatedInputTokens,
    stages: maxStages,
    reason: 'maximum_compaction_stages',
  };
}

function addUsage(
  left: ResponsesCompactionUsage | undefined,
  right: ResponsesCompactionUsage | undefined,
): ResponsesCompactionUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export class ResponsesOverflowRecoverySession {
  private readonly options: ResponsesOverflowRecoverySessionOptions;
  private readonly attemptedPrefixes = new Set<string>();
  private readonly deadlineAt: number;
  private compactCalls = 0;
  private contextRejections = 0;
  private totalUsage?: ResponsesCompactionUsage;

  constructor(options: ResponsesOverflowRecoverySessionOptions) {
    this.options = options;
    this.deadlineAt = this.now() + Math.max(1, options.deadlineMs ?? DEFAULT_RECOVERY_DEADLINE_MS);
  }

  get usage(): ResponsesCompactionUsage | undefined {
    return this.totalUsage;
  }

  get attemptCount(): number {
    return this.compactCalls;
  }

  claimCompactionCall(): OverflowCompactionClaim {
    const maxContextRejections = Math.max(
      1,
      this.options.maxContextRejections ?? DEFAULT_MAX_CONTEXT_REJECTIONS,
    );
    if (this.contextRejections >= maxContextRejections) {
      return { ok: false, reason: 'context_rejection_limit' };
    }
    const maxCompactCalls = Math.max(1, this.options.maxCompactCalls ?? DEFAULT_MAX_COMPACT_CALLS);
    if (this.compactCalls >= maxCompactCalls) return { ok: false, reason: 'compact_call_limit' };
    const remainingMs = this.deadlineAt - this.now();
    if (remainingMs <= 0) return { ok: false, reason: 'deadline' };
    this.compactCalls += 1;
    return {
      ok: true,
      attempt: this.compactCalls,
      timeoutMs: Math.max(
        1,
        Math.min(this.options.compactTimeoutMs ?? RESPONSES_COMPACT_TIMEOUT_MS, remainingMs),
      ),
    };
  }

  admitFinalCreate(): OverflowFinalCreateAdmission {
    const remainingMs = this.deadlineAt - this.now();
    if (remainingMs <= 0) return { ok: false, reason: 'deadline', remainingMs };
    const reserveMs = Math.max(
      1,
      this.options.finalCreateReserveMs ?? DEFAULT_FINAL_CREATE_RESERVE_MS,
    );
    return remainingMs < reserveMs
      ? { ok: false, reason: 'final_create_reserve', remainingMs }
      : { ok: true, remainingMs };
  }

  recordExternalCompaction(
    error?: unknown,
    usage?: ResponsesCompactionUsage,
    countContextRejection = true,
  ): void {
    this.totalUsage = addUsage(this.totalUsage, usage);
    if (
      countContextRejection
      && error instanceof ResponsesCompactionError
      && error.failureClass === 'context_length'
    ) {
      this.contextRejections += 1;
    }
  }

  async recover(
    request: ResponsesOverflowRecoveryRequest,
  ): Promise<ProgressiveOverflowRecoveryResult> {
    if (
      request.reason === 'response_context_rejection'
      && request.forceInitialCompaction
      && request.estimatedInputTokens !== undefined
      && request.estimatedInputTokens <= this.options.compactThreshold
      && request.input.length > 0
    ) {
      const directStep = await this.compactCandidate({
        source: 'inferred',
        prefix: request.input,
        tail: [],
        prefixFingerprint: itemFingerprint(request.input),
        tailFingerprint: itemFingerprint([]),
        estimatedPrefixTokens: request.estimatedInputTokens,
        estimatedTailTokens: fixedPromptTokens(request.input, request.estimatedInputTokens),
      }, request.reason, 0);
      if (
        directStep
        && directStep.estimatedInputTokens < request.estimatedInputTokens
        && directStep.estimatedInputTokens <= this.options.compactThreshold
      ) {
        this.emit({
          event: 'ws_overflow_recovery', outcome: 'stage_accepted',
          reason: request.reason, stage: 0,
          previousInputItems: request.input.length,
          inputItems: directStep.input.length,
          previousEstimatedInputTokens: request.estimatedInputTokens,
          estimatedInputTokens: directStep.estimatedInputTokens,
        });
        return {
          recovered: true,
          input: directStep.input,
          estimatedInputTokens: directStep.estimatedInputTokens,
          stages: 1,
          reason: 'target_reached',
        };
      }
      if (directStep) {
        this.emit({
          event: 'ws_overflow_recovery', outcome: 'candidate_rejected',
          reason: 'non_monotonic_progress', stage: 0,
          previousEstimatedInputTokens: request.estimatedInputTokens,
          estimatedRebasedTokens: directStep.estimatedInputTokens,
        });
      }
    }
    const result = await runProgressiveOverflowRecovery({
      fullInput: request.input,
      sources: request.sources,
      compactThreshold: this.options.compactThreshold,
      contextWindow: this.options.contextWindow,
      estimatedInputTokens: request.estimatedInputTokens,
      forceInitialCompaction: request.forceInitialCompaction,
      compactCandidate: (candidate, stage) => this.compactCandidate(candidate, request.reason, stage),
      onPlan: event => this.emit({
        event: 'ws_overflow_recovery',
        outcome: event.plan.candidates.length ? 'planned' : 'unavailable',
        reason: request.reason,
        contextWindow: this.options.contextWindow,
        compactThreshold: this.options.compactThreshold,
        estimatedInputTokens: event.estimatedInputTokens,
        sourceItems: event.inputItems,
        candidateCount: event.plan.candidates.length,
        rejected: event.plan.rejected.slice(0, REJECTED_DIAGNOSTIC_LIMIT),
        rejectedCount: event.plan.rejected.length,
        stage: event.stage,
      }),
      onAccepted: event => this.emit({
        event: 'ws_overflow_recovery',
        outcome: 'stage_accepted',
        reason: request.reason,
        contextWindow: this.options.contextWindow,
        compactThreshold: this.options.compactThreshold,
        ...event,
      }),
    });
    if (!result.recovered) {
      this.emit({
        event: 'ws_overflow_recovery',
        outcome: 'exhausted',
        reason: result.reason,
        contextWindow: this.options.contextWindow,
        compactThreshold: this.options.compactThreshold,
        stage: result.stages,
        rebasedItems: result.input.length,
        estimatedRebasedTokens: result.estimatedInputTokens,
      });
    }
    return result;
  }

  private async compactCandidate(
    candidate: OverflowRecoveryCandidate,
    reason: OverflowRecoveryReason,
    stage: number,
  ): Promise<ProgressiveOverflowRecoveryStep | undefined> {
    if (this.attemptedPrefixes.has(candidate.prefixFingerprint)) return undefined;
    const claim = this.claimCompactionCall();
    if (!claim.ok) {
      this.emit({
        event: 'ws_overflow_recovery', outcome: 'budget_exhausted', reason: claim.reason,
        compactCalls: this.compactCalls, contextRejections: this.contextRejections, stage,
      });
      return undefined;
    }
    this.attemptedPrefixes.add(candidate.prefixFingerprint);
    const startedAt = this.now();
    this.emit({
      event: 'ws_overflow_recovery', outcome: 'attempted', reason, source: candidate.source,
      contextWindow: this.options.contextWindow, compactThreshold: this.options.compactThreshold,
      prefixItems: candidate.prefix.length, tailItems: candidate.tail.length,
      estimatedPrefixTokens: candidate.estimatedPrefixTokens,
      estimatedTailTokens: candidate.estimatedTailTokens,
      prefixFingerprint: candidate.prefixFingerprint, tailFingerprint: candidate.tailFingerprint,
      attemptCount: this.attemptedPrefixes.size, compactCallAttempt: claim.attempt, stage,
    });
    this.emit({
      event: 'ws_compaction', outcome: 'started',
      transport: 'responses_compact_endpoint', mode: 'overflow_recovery',
      reason, source: candidate.source, stage,
      contextWindow: this.options.contextWindow,
      compactThreshold: this.options.compactThreshold,
      prefixItems: candidate.prefix.length,
      tailItems: candidate.tail.length,
      estimatedPrefixTokens: candidate.estimatedPrefixTokens,
      estimatedTailTokens: candidate.estimatedTailTokens,
      compactCallAttempt: claim.attempt,
    });
    try {
      const compacted = await compactResponsesWindow({
        requestUrl: this.options.requestUrl,
        headers: this.options.headers,
        payload: { ...this.options.payload, input: candidate.prefix },
        fetch: this.options.fetch,
        signal: this.options.signal,
        timeoutMs: claim.timeoutMs,
      });
      this.totalUsage = addUsage(this.totalUsage, compacted.usage);
      const input = [...compacted.output, ...candidate.tail];
      const estimatedInputTokens = candidate.estimatedTailTokens
        + (compacted.usage?.outputTokens ?? approximateResponsesItemsTokens(compacted.output));
      this.emit({
        event: 'ws_overflow_recovery', outcome: 'compact_completed', reason,
        source: candidate.source, contextWindow: this.options.contextWindow,
        compactThreshold: this.options.compactThreshold, prefixItems: candidate.prefix.length,
        compactedItems: compacted.output.length, tailItems: candidate.tail.length,
        rebasedItems: input.length, estimatedRebasedTokens: estimatedInputTokens,
        prefixFingerprint: candidate.prefixFingerprint, tailFingerprint: candidate.tailFingerprint,
        attemptCount: this.attemptedPrefixes.size, compactCallAttempt: claim.attempt, stage,
        ...(compacted.usage ?? {}),
      });
      this.emit({
        event: 'ws_compaction', outcome: 'completed',
        transport: 'responses_compact_endpoint', mode: 'overflow_recovery',
        reason, source: candidate.source, stage,
        durationMs: Math.max(0, this.now() - startedAt),
        prefixItems: candidate.prefix.length,
        compactedItems: compacted.output.length,
        tailItems: candidate.tail.length,
        estimatedRebasedTokens: estimatedInputTokens,
        compactCallAttempt: claim.attempt,
        ...(compacted.usage ?? {}),
      });
      if (estimatedInputTokens >= this.options.contextWindow) {
        this.emit({
          event: 'ws_overflow_recovery', outcome: 'candidate_rejected',
          reason: 'rebased_input_exceeds_context_window', source: candidate.source,
          contextWindow: this.options.contextWindow, estimatedRebasedTokens: estimatedInputTokens,
          prefixFingerprint: candidate.prefixFingerprint, compactCallAttempt: claim.attempt, stage,
        });
        return undefined;
      }
      return { input, estimatedInputTokens };
    } catch (error) {
      const compactError = error instanceof ResponsesCompactionError ? error : undefined;
      this.recordExternalCompaction(error, compactError?.usage);
      this.emit({
        event: 'ws_overflow_recovery', outcome: 'candidate_failed', reason,
        source: candidate.source, contextWindow: this.options.contextWindow,
        prefixFingerprint: candidate.prefixFingerprint, attemptCount: this.attemptedPrefixes.size,
        compactCallAttempt: claim.attempt, stage,
        errorType: error instanceof Error ? error.name : typeof error,
        statusCode: compactError?.statusCode, failureClass: compactError?.failureClass,
        errorCode: compactError?.errorCode, providerErrorType: compactError?.errorType,
        errorFingerprint: compactError?.errorFingerprint,
      });
      this.emit({
        event: 'ws_compaction', outcome: 'failed',
        transport: 'responses_compact_endpoint', mode: 'overflow_recovery',
        reason, source: candidate.source, stage,
        durationMs: Math.max(0, this.now() - startedAt),
        compactCallAttempt: claim.attempt,
        statusCode: compactError?.statusCode,
        failureClass: compactError?.failureClass,
        errorCode: compactError?.errorCode,
        providerErrorType: compactError?.errorType,
        errorFingerprint: compactError?.errorFingerprint,
      });
      if (!compactError || compactError.failureClass !== 'context_length') throw error;
      return undefined;
    }
  }

  private emit(event: Record<string, unknown>): void {
    this.options.onDiagnostic?.(event);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
