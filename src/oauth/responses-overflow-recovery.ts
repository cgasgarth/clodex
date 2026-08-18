import { createHash } from 'node:crypto';
import { IMAGE_INPUT_TOKEN_ESTIMATE } from '../providers/anthropic-endpoints.js';
import { isBoolean, isNumber, isObject, isString } from '../runtime/type-guards.js';
import {
  compactResponsesWindow,
  RESPONSES_COMPACT_TIMEOUT_MS,
  ResponsesCompactionError,
  type ResponsesCompactionUsage,
} from './responses-compaction.js';
import type { JsonObject, JsonValue } from './responses-websocket/types.js';

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
  prefix: JsonValue[];
  tail: JsonValue[];
  /** Provider-reported input tokens for the accepted prefix when available. */
  prefixInputTokens?: number;
}

export interface OverflowRecoveryCandidate {
  source: OverflowRecoverySourceKind;
  prefix: JsonValue[];
  tail: JsonValue[];
  prefixFingerprint: string;
  tailFingerprint: string;
  estimatedPrefixTokens: number;
  estimatedTailTokens: number;
}

export interface PlanResponsesOverflowRecoveryOptions {
  fullInput: JsonValue[];
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
  rejectedCount: number;
}

interface ProgressiveOverflowRecoveryStep {
  input: JsonValue[];
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
  fullInput: JsonValue[];
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
  input: JsonValue[];
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
  onDiagnostic?: (event: JsonObject) => void;
}

export interface ResponsesOverflowRecoveryRequest {
  reason: OverflowRecoveryReason;
  input: JsonValue[];
  sources?: OverflowRecoverySource[];
  estimatedInputTokens?: number;
  forceInitialCompaction?: boolean;
}

function record(value: JsonValue): JsonObject | undefined {
  return isObject(value) && !Array.isArray(value) ? value : undefined;
}

function responsesItemKind(value: JsonValue): string {
  const item = record(value);
  if (!item) {
    if (isString(value)) return 'string';
    if (isNumber(value)) return 'number';
    if (isBoolean(value)) return 'boolean';
    return value === undefined ? 'undefined' : 'object';
  }
  if (isString(item.type)) return item.type;
  if (isString(item.role)) return item.role;
  return 'object';
}

function isAssistantMessage(value: JsonValue): boolean {
  const item = record(value);
  return responsesItemKind(value) === 'message' && item?.role !== 'user';
}

function isModelOutput(value: JsonValue): boolean {
  const kind = responsesItemKind(value);
  return (MODEL_OUTPUT_KINDS.has(kind) || kind.endsWith('_call'))
    && (kind !== 'message' || isAssistantMessage(value));
}

function callId(value: JsonValue): string | undefined {
  const item = record(value);
  const valueId = item?.call_id;
  return isString(valueId) && valueId.length > 0 ? valueId : undefined;
}

function itemFingerprint(items: JsonValue[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
}

function approximateItemTokens(value: JsonValue): number {
  let imageCount = 0;
  const rawSerialized = JSON.stringify(value, (_key, nested) => {
    const item = record(nested);
    if (item?.type === 'input_image' || item?.type === 'input_audio') {
      imageCount += 1;
      return { type: item.type };
    }
    return nested;
  });
  const serialized = isString(rawSerialized) ? rawSerialized : '';
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4))
    + imageCount * IMAGE_INPUT_TOKEN_ESTIMATE;
}

export function approximateResponsesItemsTokens(items: JsonValue[]): number {
  return items.reduce<number>((total, item) => total + approximateItemTokens(item), 0);
}

function fixedPromptTokens(fullInput: JsonValue[], estimatedInputTokens?: number): number {
  if (estimatedInputTokens === undefined) return 0;
  return Math.max(0, estimatedInputTokens - approximateResponsesItemsTokens(fullInput));
}

function dependencyViolation(
  prefix: JsonValue[],
  tail: JsonValue[],
  trustAcceptedPrefix: boolean,
): string | undefined {
  const prefixCalls = new Set<string>();
  const prefixOutputs = new Set<string>();
  const tailCalls = new Set<string>();
  const tailOutputs = new Set<string>();

  const collect = (items: JsonValue[], calls: Set<string>, outputs: Set<string>) => {
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

interface DependencyCounts {
  prefixCalls: number;
  prefixOutputs: number;
  tailCalls: number;
  tailOutputs: number;
}

function isToolCall(value: JsonValue): boolean {
  const kind = responsesItemKind(value);
  return kind.endsWith('_call') || kind === 'function_call' || kind === 'custom_tool_call';
}

function isToolOutput(value: JsonValue): boolean {
  const kind = responsesItemKind(value);
  return TOOL_OUTPUT_KINDS.has(kind) || kind.endsWith('_call_output');
}

/**
 * Tracks whether a moving prefix/tail cut preserves tool dependencies.
 *
 * The old planner rebuilt four sets for every inferred boundary. A resumed
 * workflow can contain thousands of boundaries, turning recovery into an
 * O(n²) main-thread scan. This tracker initializes once and updates only the
 * call id crossing each cut.
 */
interface InferredDependencyTracker {
  moveToTail: (value: JsonValue) => void;
  violation: () => string | undefined;
}

function inferredDependencyTracker(input: JsonValue[]): InferredDependencyTracker {
  const counts = new Map<string, DependencyCounts>();
  const crossing = new Set<string>();
  const missingTailProducer = new Set<string>();
  const missingPrefixProducer = new Set<string>();

  const classify = (id: string, state: DependencyCounts): void => {
    crossing.delete(id);
    missingTailProducer.delete(id);
    missingPrefixProducer.delete(id);
    if (state.tailOutputs > 0 && state.prefixCalls > 0) crossing.add(id);
    if (state.tailOutputs > 0 && state.tailCalls === 0) missingTailProducer.add(id);
    if (state.prefixOutputs > 0 && state.prefixCalls === 0) missingPrefixProducer.add(id);
  };
  const stateFor = (id: string): DependencyCounts => {
    const existing = counts.get(id);
    if (existing) return existing;
    const created = { prefixCalls: 0, prefixOutputs: 0, tailCalls: 0, tailOutputs: 0 };
    counts.set(id, created);
    return created;
  };

  for (const item of input) {
    const id = callId(item);
    if (!id) continue;
    const state = stateFor(id);
    if (isToolCall(item)) state.prefixCalls += 1;
    if (isToolOutput(item)) state.prefixOutputs += 1;
  }
  for (const [id, state] of counts) classify(id, state);

  return {
    moveToTail: item => {
      const id = callId(item);
      if (!id) return;
      const state = stateFor(id);
      if (isToolCall(item)) {
        state.prefixCalls -= 1;
        state.tailCalls += 1;
      }
      if (isToolOutput(item)) {
        state.prefixOutputs -= 1;
        state.tailOutputs += 1;
      }
      classify(id, state);
    },
    violation: () => {
      if (crossing.size > 0) return 'tool_dependency_crosses_cut';
      if (missingTailProducer.size > 0) return 'tail_tool_output_has_no_tail_producer';
      if (missingPrefixProducer.size > 0) return 'prefix_tool_output_has_no_prefix_producer';
      return undefined;
    },
  };
}

function inferredBoundary(input: JsonValue[], cut: number): boolean {
  return cut > 0 && isModelOutput(input[cut]) && !isModelOutput(input[cut - 1]);
}

interface ItemTokenSum {
  itemTokens: number[];
  total: number;
}

function sumItemTokens(input: JsonValue[]): ItemTokenSum {
  const itemTokens = input.map(approximateItemTokens);
  return {
    itemTokens,
    total: itemTokens.reduce((sum, tokens) => sum + tokens, 0),
  };
}

function fixedPromptTokensFromTotal(total: number, estimatedInputTokens?: number): number {
  if (estimatedInputTokens === undefined) return 0;
  return Math.max(0, estimatedInputTokens - total);
}

interface SourceCandidate {
  source: Exclude<OverflowRecoverySourceKind, 'inferred'>;
  prefix: JsonValue[];
  tail: JsonValue[];
  prefixInputTokens?: number;
}

function sourceCandidate(source: OverflowRecoverySource): SourceCandidate {
  return {
    source: source.kind,
    prefix: source.prefix,
    tail: source.tail,
    prefixInputTokens: source.prefixInputTokens,
  };
}

function candidateTokenEstimate(
  items: JsonValue[],
  fixedTokens: number,
): number {
  return fixedTokens + approximateResponsesItemsTokens(items);
}

interface RejectionRecorder {
  reject: (source: OverflowRecoverySourceKind, reason: string) => void;
  count: () => number;
}

function boundedRejectionRecorder(
  rejected: ResponsesOverflowRecoveryPlan['rejected'],
): RejectionRecorder {
  let rejectedCount = 0;
  return {
    reject: (source, reason) => {
      rejectedCount += 1;
      if (rejected.length < REJECTED_DIAGNOSTIC_LIMIT) rejected.push({ source, reason });
    },
    count: () => rejectedCount,
  };
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
  const rejection = boundedRejectionRecorder(rejected);
  const seen = new Set<string>();
  const maxCandidates = Math.max(1, options.maxCandidates ?? 2);
  const { itemTokens, total: totalItemTokens } = sumItemTokens(options.fullInput);
  const fixedTokens = fixedPromptTokensFromTotal(totalItemTokens, options.estimatedInputTokens);

  for (const source of options.sources ?? []) {
    const candidate = sourceCandidate(source);
    if (candidates.length >= maxCandidates) break;
    if (candidate.prefix.length === 0 || candidate.tail.length === 0) {
      rejection.reject(candidate.source, 'empty_prefix_or_tail');
      continue;
    }
    const prefixFingerprint = itemFingerprint(candidate.prefix);
    if (seen.has(prefixFingerprint)) continue;
    seen.add(prefixFingerprint);

    const violation = dependencyViolation(
      candidate.prefix,
      candidate.tail,
      true,
    );
    if (violation) {
      rejection.reject(candidate.source, violation);
      continue;
    }

    const estimatedPrefixTokens = candidate.prefixInputTokens
      ?? candidateTokenEstimate(candidate.prefix, fixedTokens);
    if (estimatedPrefixTokens > options.compactThreshold) {
      rejection.reject(candidate.source, 'prefix_exceeds_compact_threshold');
      continue;
    }
    const estimatedTailTokens = candidateTokenEstimate(candidate.tail, fixedTokens);
    if (estimatedTailTokens >= options.contextWindow) {
      rejection.reject(candidate.source, 'tail_exceeds_context_window');
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

  if (candidates.length < maxCandidates) {
    const dependencies = inferredDependencyTracker(options.fullInput);
    let prefixItemTokens = totalItemTokens;
    for (let cut = options.fullInput.length - 1; cut > 0; cut -= 1) {
      dependencies.moveToTail(options.fullInput[cut]);
      prefixItemTokens -= itemTokens[cut] ?? 0;
      if (!inferredBoundary(options.fullInput, cut)) continue;

      const violation = dependencies.violation();
      if (violation) {
        rejection.reject('inferred', violation);
        continue;
      }
      const estimatedPrefixTokens = fixedTokens + prefixItemTokens;
      if (estimatedPrefixTokens > options.compactThreshold) {
        rejection.reject('inferred', 'prefix_exceeds_compact_threshold');
        continue;
      }
      const estimatedTailTokens = fixedTokens + totalItemTokens - prefixItemTokens;
      if (estimatedTailTokens >= options.contextWindow) {
        rejection.reject('inferred', 'tail_exceeds_context_window');
        continue;
      }

      const prefix = options.fullInput.slice(0, cut);
      const prefixFingerprint = itemFingerprint(prefix);
      if (seen.has(prefixFingerprint)) continue;
      seen.add(prefixFingerprint);
      const tail = options.fullInput.slice(cut);
      candidates.push({
        source: 'inferred',
        prefix,
        tail,
        prefixFingerprint,
        tailFingerprint: itemFingerprint(tail),
        estimatedPrefixTokens,
        estimatedTailTokens,
      });
      if (candidates.length >= maxCandidates) break;
    }
  }

  return { candidates, rejected, rejectedCount: rejection.count() };
}

export function estimatedRebasedInputTokens(
  compactedOutput: JsonValue[],
  tail: JsonValue[],
  fullInput: JsonValue[],
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

  recordExternalCompaction<Cause>(
    error?: Cause,
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
        rejected: event.plan.rejected,
        rejectedCount: event.plan.rejectedCount,
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
        ...compacted.usage,
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
        ...compacted.usage,
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
        errorType: error instanceof Error ? error.name : 'UnknownError',
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

  private emit(event: JsonObject): void {
    this.options.onDiagnostic?.(event);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
