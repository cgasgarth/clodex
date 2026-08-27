import { describe, it, expect } from 'bun:test';
import {
  claudeCodeClientModelId,
  normalizeRouteLookupId,
  routeLookupIds,
  stripOneMContextSuffix,
} from '../src/models/context-model-id.js';

describe('claudeCodeClientModelId', () => {
  it('appends [1m] for a genuine 1M context', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol', 1_000_000)).toBe('gpt-5.6-sol[1m]');
  });

  it('does not mislabel intermediate context sizes as 1M', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol', 272_000)).toBe('gpt-5.6-sol');
    expect(claudeCodeClientModelId('custom-model', 999_999)).toBe('custom-model');
  });

  it('leaves 200K models unchanged', () => {
    expect(claudeCodeClientModelId('claude-haiku-4-5', 200_000)).toBe('claude-haiku-4-5');
  });

  it('is idempotent when [1m] is already present', () => {
    expect(claudeCodeClientModelId('gpt-5.6-sol[1m]', 1_000_000)).toBe('gpt-5.6-sol[1m]');
  });
});

describe('routeLookupIds', () => {
  it('includes the [1m] variant', () => {
    const ids = routeLookupIds('gpt-5.6-sol');
    expect(ids).toContain('gpt-5.6-sol[1m]');
  });

  it('normalizes context suffix case to one key', () => {
    expect(normalizeRouteLookupId('sol[1M]')).toBe('sol');
  });
});

describe('stripOneMContextSuffix', () => {
  it('removes suffix case-insensitively', () => {
    expect(stripOneMContextSuffix('sonnet[1M]')).toBe('sonnet');
  });
});
