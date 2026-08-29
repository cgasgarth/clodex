import { describe, expect, it } from 'bun:test';
import {
  API_PRICING_AS_OF,
  API_PRICING_SOURCE,
  GROK_4_5_API_RATES,
  GPT_5_6_API_RATES,
  GPT_5_6_PRIORITY_API_RATES,
  canonicalPricedModelId,
  effectiveApiProcessingMode,
  estimateApiCost,
  normalizeApiProcessingMode,
} from '../src/daemon/api-pricing.js';

describe('API-equivalent pricing', () => {
  it('uses the current published OpenAI and xAI rates', () => {
    expect(API_PRICING_AS_OF).toBe('2026-08-29');
    expect(API_PRICING_SOURCE).toBe('OpenAI and xAI API pricing');
    expect(GPT_5_6_API_RATES['gpt-5.6-terra'])
      .toEqual({ input: 2, cachedInput: 0.2, output: 12 });
    expect(GPT_5_6_API_RATES['gpt-5.6-luna'])
      .toEqual({ input: 0.2, cachedInput: 0.02, output: 1.2 });
    expect(GPT_5_6_PRIORITY_API_RATES['gpt-5.6-terra'])
      .toEqual({ input: 4, cachedInput: 0.4, output: 24 });
    expect(GPT_5_6_PRIORITY_API_RATES['gpt-5.6-luna'])
      .toEqual({ input: 0.4, cachedInput: 0.04, output: 2.4 });
    expect(GROK_4_5_API_RATES).toEqual({
      shortContext: { input: 2, cachedInput: 0.3, output: 6 },
      longContext: { input: 4, cachedInput: 0.6, output: 12 },
    });
  });

  it('recognizes Claude aliases for OpenAI and Grok models', () => {
    expect(canonicalPricedModelId('sol')).toBe('gpt-5.6-sol');
    expect(canonicalPricedModelId('anthropic-openai-oauth__gpt-5.6-terra'))
      .toBe('gpt-5.6-terra');
    expect(canonicalPricedModelId('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(canonicalPricedModelId('anthropic-openai__gpt-5.6-sol[1m]'))
      .toBe('gpt-5.6-sol');
    expect(canonicalPricedModelId('grok')).toBe('grok-4.6');
    expect(canonicalPricedModelId('anthropic-xai-oauth__grok-4.6'))
      .toBe('grok-4.6');
    expect(canonicalPricedModelId('gpt-unpriced')).toBeUndefined();
  });

  it('breaks standard Sol pricing into uncached input, cache, and output', () => {
    expect(estimateApiCost({
      modelId: 'sol',
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toEqual({
      input: 5,
      cache: 6.75,
      output: 30,
      total: 41.75,
    });
  });

  it('uses each family rate throughout the 1M context window', () => {
    const terra = estimateApiCost({
      modelId: 'terra',
      inputTokens: 500_000,
      cachedInputTokens: 500_000,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(terra?.input).toBeCloseTo(1);
    expect(terra?.cache).toBeCloseTo(0.1);
    expect(terra?.output).toBeCloseTo(0.12);
    expect(terra?.total).toBeCloseTo(1.22);
    const luna = estimateApiCost({
      modelId: 'luna',
      inputTokens: 500_000,
      cachedInputTokens: 500_000,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(luna?.input).toBeCloseTo(0.1);
    expect(luna?.cache).toBeCloseTo(0.01);
    expect(luna?.output).toBeCloseTo(0.012);
    expect(luna?.total).toBeCloseTo(0.122);
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
    expect(cost?.input).toBeCloseTo(0.04);
    expect(cost?.cache).toBeCloseTo(0.004);
    expect(cost?.output).toBeCloseTo(0.024);
    expect(cost?.total).toBeCloseTo(0.068);
  });

  it('keeps Standard rates beyond the former 272K threshold', () => {
    const cost = estimateApiCost({
      modelId: 'gpt-5.6-sol',
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    expect(cost).toEqual(expect.objectContaining({
      input: 1.360005,
      cache: 0,
      output: 0.03,
    }));
    expect(cost?.total).toBeCloseTo(1.390005);
  });

  it('keeps Fast rates beyond the former 272K threshold', () => {
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
    expect(cost?.input).toBeCloseTo(2.72001);
    expect(cost?.output).toBeCloseTo(0.06);
  });

  it('uses Grok 4.5 API rates as the Grok 4.6 API equivalent', () => {
    const cost = estimateApiCost({
      modelId: 'grok',
      processingMode: 'fast',
      inputTokens: 100_000,
      cachedInputTokens: 50_000,
      cacheWriteTokens: 10_000,
      outputTokens: 20_000,
    });
    expect(cost?.input).toBeCloseTo(0.2);
    expect(cost?.cache).toBeCloseTo(0.035);
    expect(cost?.output).toBeCloseTo(0.12);
    expect(cost?.total).toBeCloseTo(0.355);
    expect(effectiveApiProcessingMode({
      processingMode: 'fast',
      modelId: 'grok',
      inputTokens: 100_000,
      cachedInputTokens: 50_000,
      cacheWriteTokens: 10_000,
    })).toBe('standard');
  });

  it('uses xAI long-context rates at 200K prompt tokens', () => {
    const cost = estimateApiCost({
      modelId: 'grok-4.6',
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(cost?.input).toBeCloseTo(0.4);
    expect(cost?.cache).toBeCloseTo(0.06);
    expect(cost?.output).toBeCloseTo(0.12);
    expect(cost?.total).toBeCloseTo(0.58);
  });
});
