import { loadPreferences, savePreferences } from '../config/config.js';
import { MAX_MODEL_CATALOG } from '../constants.js';
import { addFavorite, removeFavorite } from '../models/favorites.js';
import {
  liveProxyModelAliases,
  loadHttpProxyRoutes,
  type LoadedHttpProxyRoutes,
} from '../http-proxy/index.js';
import { normalizeModelAliases } from '../models/aliases.js';
import { runPatchCommand } from '../patcher/index.js';
import type { ProxyHandle } from '../proxy/index.js';
import { loadRegistry } from '../registry/io.js';
import type { FavoriteModel, UserPreferences } from '../types.js';

const OPENAI_PROVIDER_ID = 'openai-oauth';

export interface DaemonClaudeModelView {
  providerId: string;
  modelId: string;
  name: string;
  alias?: string;
  contextWindow?: number;
  enabled: boolean;
}

export interface DaemonClaudeModelSnapshot {
  models: DaemonClaudeModelView[];
}

export interface ModelServiceDependencies {
  loadPreferences: () => UserPreferences;
  saveFavorites: (favorites: FavoriteModel[]) => void;
  loadModels: () => Array<{
    id: string;
    name: string;
    contextWindow?: number;
    modelFormat: string;
  }>;
  loadRoutes: () => Promise<LoadedHttpProxyRoutes>;
  liveAliases: (loaded: LoadedHttpProxyRoutes) => Parameters<ProxyHandle['replaceCatalog']>[2];
  applyPatch: () => Promise<number>;
  replaceCatalog: ProxyHandle['replaceCatalog'];
}

function defaultDependencies(endpoint: ProxyHandle): ModelServiceDependencies {
  return {
    loadPreferences,
    saveFavorites: favoriteModels => savePreferences({ favoriteModels }),
    loadModels: () => {
      const provider = loadRegistry().providers.find(item => item.id === OPENAI_PROVIDER_ID);
      return provider?.modelsCache?.models ?? [];
    },
    loadRoutes: loadHttpProxyRoutes,
    liveAliases: loaded => liveProxyModelAliases(loaded),
    applyPatch: () => runPatchCommand({}),
    replaceCatalog: endpoint.replaceCatalog,
  };
}

export class DaemonClaudeModelService {
  private readonly dependencies: ModelServiceDependencies;
  private mutationTail = Promise.resolve();

  constructor(dependencies: ModelServiceDependencies) {
    this.dependencies = dependencies;
  }

  snapshot(): DaemonClaudeModelSnapshot {
    const preferences = this.dependencies.loadPreferences();
    const enabled = new Set(
      (preferences.favoriteModels ?? [])
        .filter(favorite => favorite.providerId === OPENAI_PROVIDER_ID)
        .map(favorite => favorite.modelId),
    );
    const aliases = new Map(
      normalizeModelAliases(preferences.modelAliases).aliases
        .filter(alias => alias.providerId === OPENAI_PROVIDER_ID)
        .map(alias => [alias.modelId, alias.name]),
    );
    return {
      models: this.dependencies.loadModels()
        .filter(model => model.modelFormat === 'openai')
        .map(model => ({
          providerId: OPENAI_PROVIDER_ID,
          modelId: model.id,
          name: model.name || model.id,
          alias: aliases.get(model.id),
          contextWindow: model.contextWindow,
          enabled: enabled.has(model.id),
        })),
    };
  }

  setEnabled(modelId: string, enabled: boolean): Promise<DaemonClaudeModelSnapshot> {
    const operation = this.mutationTail.then(() => this.applyEnabled(modelId, enabled));
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async applyEnabled(
    modelId: string,
    enabled: boolean,
  ): Promise<DaemonClaudeModelSnapshot> {
    const model = this.snapshot().models.find(item => item.modelId === modelId);
    if (!model) throw new Error(`OpenAI model is unavailable: ${modelId}`);
    if (model.enabled === enabled) return this.snapshot();

    const previousFavorites = this.dependencies.loadPreferences().favoriteModels ?? [];
    const favorite = { providerId: OPENAI_PROVIDER_ID, modelId };
    const nextFavorites = enabled
      ? addFavorite(previousFavorites, favorite, MAX_MODEL_CATALOG)
      : { ok: true as const, list: removeFavorite(previousFavorites, favorite) };
    if (!nextFavorites.ok) {
      throw new Error(nextFavorites.reason === 'cap'
        ? `Claude model list is limited to ${MAX_MODEL_CATALOG} models`
        : `${model.name} is already enabled`);
    }

    this.dependencies.saveFavorites(nextFavorites.list);
    try {
      const loaded = await this.dependencies.loadRoutes();
      if (loaded.routes.length === 0) {
        throw new Error('At least one compatible Claude model must remain enabled');
      }
      if (await this.dependencies.applyPatch() !== 0) {
        throw new Error('Claude model list patch failed');
      }
      this.dependencies.replaceCatalog(
        loaded.routes,
        loaded.routes[0]!.aliasId,
        this.dependencies.liveAliases(loaded),
      );
      return this.snapshot();
    } catch (error) {
      this.dependencies.saveFavorites(previousFavorites);
      throw error;
    }
  }
}

export function createDaemonClaudeModelController(
  endpoint: ProxyHandle,
): DaemonClaudeModelService {
  return new DaemonClaudeModelService(defaultDependencies(endpoint));
}
