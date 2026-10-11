import { describe, expect, it } from 'bun:test';
import {
  API_PRICING_AS_OF,
  API_PRICING_SOURCE,
  OPENAI_API_RATES,
  OPENAI_PRIORITY_API_RATES,
  canonicalPricedModelId,
  effectiveApiProcessingMode,
  estimateApiCost,
  normalizeApiProcessingMode,
} from '../src/daemon/api-pricing.js';

describe('API-equivalent pricing', () => {
  it('uses the current published OpenAI rates', () => {
    expect(API_PRICING_AS_OF).toBe('2026-10-10');
    expect(API_PRICING_SOURCE).toBe('OpenAI API pricing');
    expect(OPENAI_API_RATES['gpt-6-astra'])
      .toEqual({ input: 10, cachedInput: 1, output: 50 });
    expect(OPENAI_PRIORITY_API_RATES['gpt-6-astra'])
      .toEqual({ input: 20, cachedInput: 2, output: 100 });
    expect(OPENAI_API_RATES['gpt-6.1-sol'])
      .toEqual({ input: 2, cachedInput: 0.1, output: 10 });
    expect(OPENAI_API_RATES['gpt-6-luna'])
      .toEqual({ input: 0.1, cachedInput: 0.01, output: 0.5 });
    expect(OPENAI_PRIORITY_API_RATES['gpt-6.1-sol'])
      .toEqual({ input: 4, cachedInput: 0.2, output: 20 });
    expect(OPENAI_PRIORITY_API_RATES['gpt-6-luna'])
      .toEqual({ input: 0.2, cachedInput: 0.02, output: 1 });
  });

  it('recognizes Claude aliases for OpenAI models', () => {
    expect(canonicalPricedModelId('astra')).toBe('gpt-6-astra');
    expect(canonicalPricedModelId('anthropic-openai-oauth__gpt-6-astra[1m]'))
      .toBe('gpt-6-astra');
    expect(canonicalPricedModelId('sol')).toBe('gpt-6.1-sol');
    expect(canonicalPricedModelId('sol-6.1[1m]')).toBe('gpt-6.1-sol');
    expect(canonicalPricedModelId('luna')).toBe('gpt-6-luna');
    expect(canonicalPricedModelId('anthropic-openai__gpt-6.1-sol[1m]'))
      .toBe('gpt-6.1-sol');
    expect(canonicalPricedModelId('gpt-5.6-terra')).toBeUndefined();
    expect(canonicalPricedModelId('gpt-unpriced')).toBeUndefined();
  });

  it('prices GPT-6 Astra cache writes and output at published Standard rates', () => {
    expect(estimateApiCost({
      modelId: 'astra',
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 50_000,
      outputTokens: 10_000,
    })).toEqual({
      input: 1,
      cache: 0.725,
      output: 0.5,
      total: 2.225,
    });
  });

  it.each([
    ['gpt-6-astra', 5.44002, 0.75],
    ['gpt-6.1-sol', 1.088004, 0.15],
    ['gpt-6-luna', 0.0544002, 0.0075],
  ])('applies %s long-context rates above 272K input tokens', (modelId, input, output) => {
    const cost = estimateApiCost({
      modelId,
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(cost?.input).toBeCloseTo(input, 9);
    expect(cost?.output).toBeCloseTo(output, 9);
  });

  it('breaks standard Sol pricing into uncached input, cache, and output', () => {
    expect(estimateApiCost({
      modelId: 'sol',
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 50_000,
      outputTokens: 100_000,
    })).toEqual({
      input: 0.2,
      cache: 0.135,
      output: 1,
      total: 1.335,
    });
  });

  it('prices Fast requests at twice Standard and accepts the legacy priority name', () => {
    expect(normalizeApiProcessingMode('priority')).toBe('fast');
    expect(normalizeApiProcessingMode('fast')).toBe('fast');
    expect(normalizeApiProcessingMode('default')).toBe('standard');
    const cost = estimateApiCost({
      modelId: 'luna',
      processingMode: 'fast',
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(cost?.input).toBeCloseTo(0.02);
    expect(cost?.cache).toBeCloseTo(0.002);
    expect(cost?.output).toBeCloseTo(0.01);
    expect(cost?.total).toBeCloseTo(0.032);
  });

  it('doubles long-context rates for Fast requests', () => {
    const usage = {
      modelId: 'sol',
      processingMode: 'fast' as const,
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    };
    const cost = estimateApiCost(usage);
    expect(effectiveApiProcessingMode(usage)).toBe('fast');
    expect(cost?.input).toBeCloseTo(2.176008);
    expect(cost?.output).toBeCloseTo(0.03);
  });
});
