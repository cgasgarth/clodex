import { describe, expect, it } from 'bun:test';
import {
  filterServerModelsByFreeStatus,
  filterServerModelsByFavorites,
  filterServerModelsByProviders,
  summarizeServerProviders,
} from '../src/server/catalog-filter.js';
import { resolveInitialServerProviders } from '../src/server/provider-select.js';
import type { ServerModelInfo } from '../src/server/models.js';

function model(partial: Partial<ServerModelInfo> & Pick<ServerModelInfo, 'id' | 'providerId'>): ServerModelInfo {
  return {
    name: partial.id,
    isFree: false,
    brand: 'Other',
    sourceBackend: 'zen',
    modelFormat: 'openai',
    providerLabel: partial.providerLabel ?? partial.providerId,
    ...partial,
  };
}

describe('filterServerModelsByProviders', () => {
  const models = [
    model({ id: 'gemini-3', providerId: 'google', providerLabel: 'Google' }),
    model({ id: 'grok-4.6', providerId: 'xai-oauth', providerLabel: 'xAI (SuperGrok)' }),
    model({ id: 'big-pickle', providerId: 'zen', providerLabel: 'OpenCode Zen' }),
  ];

  it('returns all models when provider filter is unset', () => {
    expect(filterServerModelsByProviders(models, null)).toHaveLength(3);
    expect(filterServerModelsByProviders(models, undefined)).toHaveLength(3);
    expect(filterServerModelsByProviders(models, [])).toHaveLength(3);
  });

  it('keeps only models from selected providers', () => {
    const filtered = filterServerModelsByProviders(models, ['google', 'zen']);
    expect(filtered.map(m => m.id)).toEqual(['gemini-3', 'big-pickle']);
  });
});

describe('filterServerModelsByFavorites', () => {
  const models = [
    model({ id: 'gpt-5.5-fast', providerId: 'openai', providerLabel: 'OpenAI' }),
    model({ id: 'gemini-3.5-flash', providerId: 'google', providerLabel: 'Google' }),
    model({ id: 'grok-4.6', providerId: 'xai-oauth', providerLabel: 'xAI (SuperGrok)' }),
  ];

  it('returns empty list when there are no favorites', () => {
    expect(filterServerModelsByFavorites(models, [])).toEqual([]);
  });

  it('keeps only favorited provider/model pairs', () => {
    const filtered = filterServerModelsByFavorites(models, [
      { providerId: 'google', modelId: 'gemini-3.5-flash' },
      { providerId: 'xai-oauth', modelId: 'grok-4.6' },
    ]);
    expect(filtered.map(m => m.id)).toEqual(['gemini-3.5-flash', 'grok-4.6']);
  });
});

describe('resolveInitialServerProviders', () => {
  const available = [
    { id: 'google', name: 'Google', modelCount: 18 },
    { id: 'xai-oauth', name: 'xAI (SuperGrok)', modelCount: 1 },
    { id: 'openrouter', name: 'OpenRouter', modelCount: 338 },
  ];

  it('starts empty when nothing is saved', () => {
    expect(resolveInitialServerProviders(undefined, available)).toEqual([]);
    expect(resolveInitialServerProviders([], available)).toEqual([]);
  });

  it('restores only saved providers that still exist', () => {
    expect(resolveInitialServerProviders(['google', 'xai-oauth', 'gone'], available)).toEqual(['google', 'xai-oauth']);
  });
});

describe('summarizeServerProviders', () => {
  it('groups models by provider label', () => {
    const summary = summarizeServerProviders([
      model({ id: 'a', providerId: 'google', providerLabel: 'Google' }),
      model({ id: 'b', providerId: 'google', providerLabel: 'Google' }),
      model({ id: 'c', providerId: 'xai-oauth', providerLabel: 'xAI (SuperGrok)' }),
    ]);
    expect(summary).toBe('Google (2), xAI (SuperGrok) (1)');
  });
});
