import { describe, expect, it, vi } from 'bun:test';
import {
  DaemonClaudeModelService,
  type ModelServiceDependencies,
} from '../src/daemon/model-service.js';
import type { LoadedHttpProxyRoutes } from '../src/http-proxy/index.js';
import type { ProxyRoute } from '../src/proxy/index.js';
import type { FavoriteModel, UserPreferences } from '../src/types.js';

const modelSeeds = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    contextWindow: 272_000,
    modelFormat: 'openai',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    contextWindow: 272_000,
    modelFormat: 'openai',
  },
];

function route(modelId: string): ProxyRoute {
  return {
    aliasId: `clodex:openai-oauth:${modelId}`,
    realModelId: modelId,
    displayName: modelId,
    upstreamUrl: 'https://example.test',
    apiKey: 'token',
    modelFormat: 'openai',
  };
}

function harness(initial: FavoriteModel[]) {
  let preferences: UserPreferences = {
    favoriteModels: initial,
    modelAliases: [
      {
        name: 'sol',
        providerId: 'openai-oauth',
        modelId: 'gpt-5.6-sol',
      },
    ],
  };
  const replaceCatalog = vi.fn();
  const syncSettings = vi.fn();
  const loadRoutes = vi.fn(async (): Promise<LoadedHttpProxyRoutes> => {
    const favorites = preferences.favoriteModels ?? [];
    const routes = favorites
      .filter(item => item.providerId === 'openai-oauth')
      .map(item => route(item.modelId));
    return {
      routes,
      aliases: [],
      unavailable: [],
      unsupported: [],
      unavailableAliases: [],
      favoriteCount: favorites.length,
    };
  });
  const dependencies: ModelServiceDependencies = {
    loadPreferences: () => structuredClone(preferences),
    saveFavorites: favoriteModels => {
      preferences = { ...preferences, favoriteModels };
    },
    loadModels: () => modelSeeds,
    loadRoutes,
    liveAliases: () => [],
    syncSettings,
    replaceCatalog,
  };
  return {
    service: new DaemonClaudeModelService(dependencies),
    loadRoutes,
    syncSettings,
    replaceCatalog,
    preferences: () => preferences,
  };
}

describe('daemon Claude model service', () => {
  it('reports OpenAI models, aliases, context windows, and enabled state', () => {
    const { service } = harness([
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);

    expect(service.snapshot().models).toEqual([
      expect.objectContaining({
        modelId: 'gpt-5.6-sol',
        alias: 'sol',
        contextWindow: 272_000,
        enabled: true,
      }),
      expect.objectContaining({
        modelId: 'gpt-5.6-luna',
        enabled: false,
      }),
    ]);
  });

  it('atomically replaces the live catalog after enabling a model', async () => {
    const { service, replaceCatalog, syncSettings, preferences } = harness([
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);

    const snapshot = await service.setEnabled('gpt-5.6-luna', true);

    expect(snapshot.models.find(model => model.modelId === 'gpt-5.6-luna')?.enabled).toBe(true);
    expect(preferences().favoriteModels).toContainEqual({
      providerId: 'openai-oauth',
      modelId: 'gpt-5.6-luna',
    });
    expect(syncSettings).toHaveBeenCalledOnce();
    expect(replaceCatalog).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ realModelId: 'gpt-5.6-sol' }),
        expect.objectContaining({ realModelId: 'gpt-5.6-luna' }),
      ]),
      'clodex:openai-oauth:gpt-5.6-sol',
      [],
    );
  });

  it('rolls configuration back and leaves the live catalog alone when loading fails', async () => {
    const state = harness([
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);
    state.loadRoutes.mockRejectedValueOnce(new Error('catalog load failed'));

    await expect(state.service.setEnabled('gpt-5.6-luna', true))
      .rejects.toThrow('catalog load failed');

    expect(state.preferences().favoriteModels).toEqual([
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);
    expect(state.replaceCatalog).not.toHaveBeenCalled();
  });

  it('refuses to disable the final compatible model', async () => {
    const state = harness([
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);

    await expect(state.service.setEnabled('gpt-5.6-sol', false))
      .rejects.toThrow('At least one compatible Claude model must remain enabled');

    expect(state.preferences().favoriteModels).toEqual([
      { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);
    expect(state.loadRoutes).toHaveBeenCalledOnce();
  });
});
