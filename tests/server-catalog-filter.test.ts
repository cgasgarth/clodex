import { describe, expect, it } from 'bun:test';
import {
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
    model({ id: 'mistral-large', providerId: 'mistral', providerLabel: 'Mistral' }),
    model({ id: 'mistral-large', providerId: 'mistral', providerLabel: 'Mistral' }),
    model({ id: 'big-pickle', providerId: 'zen', providerLabel: 'OpenCode Zen' }),
  ];

  it('returns all models when provider filter is unset', () => {
    expect(filterServerModelsByProviders(models, null)).toHaveLength(3);
    expect(filterServerModelsByProviders(models, undefined)).toHaveLength(3);
    expect(filterServerModelsByProviders(models, [])).toHaveLength(3);
  });

  it('keeps only models from selected providers', () => {
    const filtered = filterServerModelsByProviders(models, ['mistral', 'zen']);
    expect(filtered.map(m => m.id)).toEqual(['mistral-large', 'big-pickle']);
  });
});

describe('filterServerModelsByFavorites', () => {
  const models = [
    model({ id: 'gpt-5.5-fast', providerId: 'openai', providerLabel: 'OpenAI' }),
    model({ id: 'mistral-large', providerId: 'mistral', providerLabel: 'Mistral' }),
    model({ id: 'mistral-large', providerId: 'mistral', providerLabel: 'Mistral' }),
  ];

  it('returns empty list when there are no favorites', () => {
    expect(filterServerModelsByFavorites(models, [])).toEqual([]);
  });

  it('keeps only favorited provider/model pairs', () => {
    const filtered = filterServerModelsByFavorites(models, [
      { providerId: 'mistral', modelId: 'mistral-large' },
      { providerId: 'mistral', modelId: 'mistral-large' },
    ]);
    expect(filtered.map(m => m.id)).toEqual(['mistral-large', 'mistral-large']);
  });
});

describe('resolveInitialServerProviders', () => {
  const available = [
    { id: 'mistral', name: 'Mistral', modelCount: 18 },
    { id: 'mistral', name: 'Mistral', modelCount: 1 },
    { id: 'openrouter', name: 'OpenRouter', modelCount: 338 },
  ];

  it('starts empty when nothing is saved', () => {
    expect(resolveInitialServerProviders(undefined, available)).toEqual([]);
    expect(resolveInitialServerProviders([], available)).toEqual([]);
  });

  it('restores only saved providers that still exist', () => {
    expect(resolveInitialServerProviders(['mistral', 'mistral', 'gone'], available)).toEqual(['mistral', 'mistral']);
  });
});

describe('summarizeServerProviders', () => {
  it('groups models by provider label', () => {
    const summary = summarizeServerProviders([
      model({ id: 'a', providerId: 'mistral', providerLabel: 'Mistral' }),
      model({ id: 'b', providerId: 'mistral', providerLabel: 'Mistral' }),
      model({ id: 'c', providerId: 'mistral', providerLabel: 'Mistral' }),
    ]);
    expect(summary).toBe('Mistral (2), Mistral (1)');
  });
});
