import { createHash } from 'node:crypto';
import { IMAGE_INPUT_TOKEN_ESTIMATE } from '../anthropic-endpoints.js';

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
