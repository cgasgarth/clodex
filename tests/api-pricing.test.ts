import { describe, expect, it } from 'bun:test';
import {
  canonicalPricedModelId,
  effectiveApiProcessingMode,
  estimateApiCost,
  normalizeApiProcessingMode,
} from '../src/daemon/api-pricing.js';

describe('API-equivalent pricing', () => {
  it('recognizes Claude aliases and only prices Sol, Terra, and Luna', () => {
    expect(canonicalPricedModelId('sol')).toBe('gpt-5.6-sol');
    expect(canonicalPricedModelId('anthropic-openai-oauth__gpt-5.6-terra'))
      .toBe('gpt-5.6-terra');
    expect(canonicalPricedModelId('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(canonicalPricedModelId('anthropic-openai__gpt-5.6-sol[1m]'))
      .toBe('gpt-5.6-sol');
    expect(canonicalPricedModelId('gpt-5.3-codex-spark')).toBeUndefined();
  });

  it('breaks standard Sol pricing into uncached input, cache, and output', () => {
    expect(estimateApiCost({
      modelId: 'sol',
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toEqual({
      input: 10,
      cache: 13.5,
      output: 45,
      total: 68.5,
    });
  });

  it('uses each family rate below the long-context threshold', () => {
    const terra = estimateApiCost({
      modelId: 'terra',
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(terra).toEqual(expect.objectContaining({
      input: 0.25,
      cache: 0.025,
      output: 0.15,
    }));
    expect(terra?.total).toBeCloseTo(0.425);
    const luna = estimateApiCost({
      modelId: 'luna',
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(luna?.input).toBeCloseTo(0.1);
    expect(luna?.cache).toBeCloseTo(0.01);
    expect(luna?.output).toBeCloseTo(0.06);
    expect(luna?.total).toBeCloseTo(0.17);
  });

  it('prices fast requests at Priority rates and normalizes service-tier names', () => {
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
    expect(cost?.input).toBeCloseTo(0.2);
    expect(cost?.cache).toBeCloseTo(0.02);
    expect(cost?.output).toBeCloseTo(0.12);
    expect(cost?.total).toBeCloseTo(0.34);
  });

  it('applies long-context multipliers to the full request', () => {
    const cost = estimateApiCost({
      modelId: 'gpt-5.6-sol',
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    expect(cost).toEqual(expect.objectContaining({
      input: 2.72001,
      cache: 0,
      output: 0.045,
    }));
    expect(cost?.total).toBeCloseTo(2.76501);
  });

  it('falls long-context fast requests back to Standard long-context pricing', () => {
    const usage = {
      modelId: 'sol',
      processingMode: 'fast' as const,
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    };
    const cost = estimateApiCost(usage);
    expect(effectiveApiProcessingMode(usage)).toBe('standard');
    expect(cost?.input).toBeCloseTo(2.72001);
    expect(cost?.output).toBeCloseTo(0.045);
  });
});
