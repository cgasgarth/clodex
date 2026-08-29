export const API_PRICING_SOURCE = 'OpenAI and xAI API pricing';
export const API_PRICING_AS_OF = '2026-08-29';
const XAI_LONG_CONTEXT_INPUT_TOKENS = 200_000;

const TOKENS_PER_MILLION = 1_000_000;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

interface ApiTokenRates {
  input: number;
  cachedInput: number;
  output: number;
}

interface ApiRateCatalog {
  readonly [modelId: string]: ApiTokenRates;
}

interface GrokContextRates {
  shortContext: ApiTokenRates;
  longContext: ApiTokenRates;
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
export const GPT_5_6_API_RATES: ApiRateCatalog = {
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

/** Fast processing prices in USD per one million tokens (2x Standard). */
export const GPT_5_6_PRIORITY_API_RATES: ApiRateCatalog = {
  'gpt-5.6-sol': { input: 10, cachedInput: 1, output: 60 },
  'gpt-5.6-terra': { input: 4, cachedInput: 0.4, output: 24 },
  'gpt-5.6-luna': { input: 0.4, cachedInput: 0.04, output: 2.4 },
};

/** Grok 4.5 API prices used as the public API equivalent for subscription-only Grok 4.6. */
export const GROK_4_5_API_RATES: Readonly<GrokContextRates> = {
  shortContext: { input: 2, cachedInput: 0.3, output: 6 },
  longContext: { input: 4, cachedInput: 0.6, output: 12 },
};

export function normalizeApiProcessingMode<Value>(value: Value): ApiProcessingMode {
  return value === 'fast' || value === 'priority' ? 'fast' : 'standard';
}

export function effectiveApiProcessingMode(
  usage: Pick<ApiPricedUsage, 'modelId' | 'processingMode'>,
): ApiProcessingMode {
  const modelId = canonicalPricedModelId(usage.modelId);
  return normalizeApiProcessingMode(usage.processingMode) === 'fast'
    && modelId !== undefined
    && GPT_5_6_API_RATES[modelId] !== undefined
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
  if (withoutContextSuffix === 'grok' || withoutContextSuffix === 'grok-4.6') {
    return 'grok-4.6';
  }
  return GPT_5_6_API_RATES[withoutContextSuffix] ? withoutContextSuffix : undefined;
}

export function estimateApiCost(usage: ApiPricedUsage): ApiCostBreakdown | undefined {
  const modelId = canonicalPricedModelId(usage.modelId);
  if (!modelId) return undefined;
  const logicalInputTokens = usage.inputTokens
    + usage.cachedInputTokens
    + usage.cacheWriteTokens;
  if (modelId === 'grok-4.6') {
    const rates = logicalInputTokens >= XAI_LONG_CONTEXT_INPUT_TOKENS
      ? GROK_4_5_API_RATES.longContext
      : GROK_4_5_API_RATES.shortContext;
    const input = usage.inputTokens / TOKENS_PER_MILLION * rates.input;
    const cacheRead = usage.cachedInputTokens / TOKENS_PER_MILLION * rates.cachedInput;
    // xAI publishes cache-read pricing but no separate cache-write surcharge.
    const cacheWrite = usage.cacheWriteTokens / TOKENS_PER_MILLION * rates.input;
    const cache = cacheRead + cacheWrite;
    const output = usage.outputTokens / TOKENS_PER_MILLION * rates.output;
    return { input, cache, output, total: input + cache + output };
  }
  const fast = effectiveApiProcessingMode(usage) === 'fast';
  const rates = (fast ? GPT_5_6_PRIORITY_API_RATES : GPT_5_6_API_RATES)[modelId]!;
  const input = usage.inputTokens / TOKENS_PER_MILLION * rates.input;
  const cacheRead = usage.cachedInputTokens / TOKENS_PER_MILLION * rates.cachedInput;
  const cacheWrite = usage.cacheWriteTokens
    / TOKENS_PER_MILLION
    * rates.input
    * CACHE_WRITE_INPUT_MULTIPLIER;
  const cache = cacheRead + cacheWrite;
  const output = usage.outputTokens / TOKENS_PER_MILLION * rates.output;
  return { input, cache, output, total: input + cache + output };
}
