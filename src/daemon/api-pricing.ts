export const API_PRICING_SOURCE = 'OpenAI Standard and Fast API pricing';
export const API_PRICING_AS_OF = '2026-07-30';
export const LONG_CONTEXT_INPUT_TOKENS = 272_000;

const TOKENS_PER_MILLION = 1_000_000;
const LONG_CONTEXT_INPUT_MULTIPLIER = 2;
const LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

export interface ApiTokenRates {
  input: number;
  cachedInput: number;
  output: number;
}

export type ApiProcessingMode = 'standard' | 'fast';

export interface ApiCostBreakdown {
  input: number;
  cache: number;
  output: number;
  total: number;
}

export interface ApiPricedUsage {
  modelId: string;
  processingMode?: ApiProcessingMode;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Standard processing prices in USD per one million tokens. */
export const GPT_5_6_API_RATES: Readonly<Record<string, ApiTokenRates>> = {
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

/** Fast processing prices in USD per one million tokens (2x Standard). */
export const GPT_5_6_PRIORITY_API_RATES: Readonly<Record<string, ApiTokenRates>> = {
  'gpt-5.6-sol': { input: 10, cachedInput: 1, output: 60 },
  'gpt-5.6-terra': { input: 4, cachedInput: 0.4, output: 24 },
  'gpt-5.6-luna': { input: 0.4, cachedInput: 0.04, output: 2.4 },
};

export function normalizeApiProcessingMode(value: unknown): ApiProcessingMode {
  return value === 'fast' || value === 'priority' ? 'fast' : 'standard';
}

export function effectiveApiProcessingMode(
  usage: Pick<ApiPricedUsage, 'processingMode' | 'inputTokens' | 'cachedInputTokens' | 'cacheWriteTokens'>,
): ApiProcessingMode {
  const logicalInputTokens = usage.inputTokens
    + usage.cachedInputTokens
    + usage.cacheWriteTokens;
  return normalizeApiProcessingMode(usage.processingMode) === 'fast'
    && logicalInputTokens <= LONG_CONTEXT_INPUT_TOKENS
    ? 'fast'
    : 'standard';
}

export function canonicalPricedModelId(modelId: string): string | undefined {
  const normalized = modelId.trim().toLowerCase();
  const routed = normalized.includes('__')
    ? normalized.slice(normalized.lastIndexOf('__') + 2)
    : normalized;
  const withoutContextSuffix = routed.replace(/\[1m\]$/, '');
  if (withoutContextSuffix === 'gpt-5.6') return 'gpt-5.6-sol';
  if (withoutContextSuffix === 'sol') return 'gpt-5.6-sol';
  if (withoutContextSuffix === 'terra') return 'gpt-5.6-terra';
  if (withoutContextSuffix === 'luna') return 'gpt-5.6-luna';
  return GPT_5_6_API_RATES[withoutContextSuffix] ? withoutContextSuffix : undefined;
}

export function estimateApiCost(usage: ApiPricedUsage): ApiCostBreakdown | undefined {
  const modelId = canonicalPricedModelId(usage.modelId);
  if (!modelId) return undefined;
  const logicalInputTokens = usage.inputTokens
    + usage.cachedInputTokens
    + usage.cacheWriteTokens;
  const longContext = logicalInputTokens > LONG_CONTEXT_INPUT_TOKENS;
  // OpenAI Fast processing excludes requests estimated above 272K prompt
  // tokens. Those requests are served/billed as Standard long-context traffic.
  const fast = effectiveApiProcessingMode(usage) === 'fast';
  const rates = (fast ? GPT_5_6_PRIORITY_API_RATES : GPT_5_6_API_RATES)[modelId]!;
  const inputMultiplier = longContext ? LONG_CONTEXT_INPUT_MULTIPLIER : 1;
  const outputMultiplier = longContext ? LONG_CONTEXT_OUTPUT_MULTIPLIER : 1;
  const input = usage.inputTokens / TOKENS_PER_MILLION * rates.input * inputMultiplier;
  const cacheRead = usage.cachedInputTokens
    / TOKENS_PER_MILLION
    * rates.cachedInput
    * inputMultiplier;
  const cacheWrite = usage.cacheWriteTokens
    / TOKENS_PER_MILLION
    * rates.input
    * CACHE_WRITE_INPUT_MULTIPLIER
    * inputMultiplier;
  const cache = cacheRead + cacheWrite;
  const output = usage.outputTokens
    / TOKENS_PER_MILLION
    * rates.output
    * outputMultiplier;
  return { input, cache, output, total: input + cache + output };
}
