export const API_PRICING_SOURCE = 'OpenAI API pricing';
export const API_PRICING_AS_OF = '2026-09-04';
const ASTRA_LONG_CONTEXT_INPUT_TOKENS = 272_000;

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
export const OPENAI_API_RATES: ApiRateCatalog = {
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

/** Fast processing prices in USD per one million tokens (2x Standard). */
export const OPENAI_PRIORITY_API_RATES: ApiRateCatalog = {
  'gpt-6-astra': { input: 20, cachedInput: 2, output: 100 },
  'gpt-5.6-sol': { input: 10, cachedInput: 1, output: 60 },
  'gpt-5.6-terra': { input: 4, cachedInput: 0.4, output: 24 },
  'gpt-5.6-luna': { input: 0.4, cachedInput: 0.04, output: 2.4 },
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
    && OPENAI_API_RATES[modelId] !== undefined
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
  if (withoutContextSuffix === 'astra') return 'gpt-6-astra';
  if (withoutContextSuffix === 'sol') return 'gpt-5.6-sol';
  if (withoutContextSuffix === 'terra') return 'gpt-5.6-terra';
  if (withoutContextSuffix === 'luna') return 'gpt-5.6-luna';
  return OPENAI_API_RATES[withoutContextSuffix] ? withoutContextSuffix : undefined;
}

export function estimateApiCost(usage: ApiPricedUsage): ApiCostBreakdown | undefined {
  const modelId = canonicalPricedModelId(usage.modelId);
  if (!modelId) return undefined;
  const logicalInputTokens = usage.inputTokens
    + usage.cachedInputTokens
    + usage.cacheWriteTokens;
  const fast = effectiveApiProcessingMode(usage) === 'fast';
  const rates = (fast ? OPENAI_PRIORITY_API_RATES : OPENAI_API_RATES)[modelId]!;
  const usesAstraLongContextRates = modelId === 'gpt-6-astra'
    && logicalInputTokens > ASTRA_LONG_CONTEXT_INPUT_TOKENS;
  const inputRate = rates.input * (usesAstraLongContextRates ? 2 : 1);
  const cachedInputRate = rates.cachedInput * (usesAstraLongContextRates ? 2 : 1);
  const outputRate = rates.output * (usesAstraLongContextRates ? 1.5 : 1);
  const input = usage.inputTokens / TOKENS_PER_MILLION * inputRate;
  const cacheRead = usage.cachedInputTokens / TOKENS_PER_MILLION * cachedInputRate;
  const cacheWrite = usage.cacheWriteTokens
    / TOKENS_PER_MILLION
    * inputRate
    * CACHE_WRITE_INPUT_MULTIPLIER;
  const cache = cacheRead + cacheWrite;
  const output = usage.outputTokens / TOKENS_PER_MILLION * outputRate;
  return { input, cache, output, total: input + cache + output };
}
