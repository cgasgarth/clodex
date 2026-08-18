import pc from 'picocolors';
import {
  relayIntro,
  relayOutro,
  providerSelectOption,
  fmtModel,
  fmtEnabledStar,
  formatModelLabel,
} from '../ui/prompts.js';
import * as p from '@clack/prompts';
import { MAX_MODEL_CATALOG } from '../constants.js';
import { loadPreferences, savePreferences } from '../config/config.js';
import { fetchProviderCatalog, providersForPicker } from '../models/provider-catalog.js';
import type { FavoriteModel, LocalProvider, LocalProviderModel } from '../types.js';
import { addFavorite, removeFavorite, isFavorite } from '../models/favorites.js';
import {
  canonicalModelAliasName,
  modelAliasMatchesName,
  modelAliasMatchesStoredName,
  modelAliasTarget,
  parseModelAliasAssignment,
} from '../models/aliases.js';
import {
  browseByProviderChoice,
  buildGlobalFavoriteIndex,
  pickGlobalFavoriteModel,
} from '../models/favorites-picker.js';
import { favoriteProviderDisplayName } from '../models/favorite-provider-display.js';
import {
  loadHttpProxyRoutes,
  printHttpProxyModels,
  reportSkippedHttpProxyFavorites,
} from '../http-proxy/index.js';

interface FavoritesCommandOptions {
  list?: boolean;
  alias?: string;
  unalias?: string;
}

interface FavoriteAddition {
  provider: LocalProvider;
  models: LocalProviderModel[];
}

async function browseProviderFavoriteModels(
  providers: LocalProvider[],
  favorites: FavoriteModel[],
): Promise<FavoriteAddition | null> {
  let currentProviderId: string | undefined;
  for (;;) {
    const pickedProviderId = await p.select<string>({
      message: 'Which provider?',
      options: providers.map(provider => providerSelectOption(provider)),
      initialValue: currentProviderId,
    });
    if (p.isCancel(pickedProviderId)) return null;
    const provider = providers.find(candidate => candidate.id === pickedProviderId);
    if (!provider) return null;
    const pickedModelIds = await p.multiselect({
      message: `Select models to add from ${provider.name} ${pc.dim('(Space to select, Enter to confirm)')}`,
      options: provider.models.map(model => ({
        value: model.id,
        label: fmtModel(formatModelLabel(model), model.id),
        hint: isFavorite(favorites, { providerId: provider.id, modelId: model.id })
          ? pc.yellow('★ already favorite')
          : '',
      })),
      required: false,
    });
    if (p.isCancel(pickedModelIds) || pickedModelIds.length === 0) {
      currentProviderId = provider.id;
      continue;
    }
    return {
      provider,
      models: provider.models.filter(model => pickedModelIds.includes(model.id)),
    };
  }
}

async function selectFavoriteAddition(
  providers: LocalProvider[],
  favorites: FavoriteModel[],
): Promise<FavoriteAddition | null> {
  const globalCount = buildGlobalFavoriteIndex(providers).length;
  const addPath = await p.select<string>({
    message: 'Add a favorite',
    options: [
      {
        value: 'global',
        label: pc.cyan('Search all providers'),
        hint: `${globalCount} models · ${providers.length} provider${providers.length !== 1 ? 's' : ''}`,
      },
      {
        value: 'provider',
        label: pc.cyan('Browse by provider →'),
        hint: 'Pick one provider first',
      },
    ],
  });
  if (p.isCancel(addPath)) return null;
  if (addPath !== 'global') return browseProviderFavoriteModels(providers, favorites);
  const globalPick = await pickGlobalFavoriteModel(providers, favorites);
  if (globalPick === null) return null;
  if (globalPick === browseByProviderChoice) {
    return browseProviderFavoriteModels(providers, favorites);
  }
  const provider = providers.find(candidate => candidate.id === globalPick.providerId);
  return provider ? { provider, models: [globalPick.model] } : null;
}

interface FavoriteAdditionResult {
  favorites: FavoriteModel[];
  addedModels: LocalProviderModel[];
  duplicateCount: number;
  limitReached: boolean;
}

function applyFavoriteAddition(
  favorites: FavoriteModel[],
  addition: FavoriteAddition,
  maxFavorites: number,
): FavoriteAdditionResult {
  let nextFavorites = favorites;
  const addedModels: LocalProviderModel[] = [];
  let duplicateCount = 0;
  let limitReached = false;
  for (const model of addition.models) {
    const result = addFavorite(
      nextFavorites,
      { providerId: addition.provider.id, modelId: model.id },
      maxFavorites,
    );
    if (result.ok) {
      nextFavorites = result.list;
      addedModels.push(model);
      continue;
    }
    if (result.reason === 'duplicate') {
      duplicateCount += 1;
      continue;
    }
    limitReached = true;
    break;
  }
  return { favorites: nextFavorites, addedModels, duplicateCount, limitReached };
}

function reportFavoriteAddition(
  addition: FavoriteAddition,
  result: ReturnType<typeof applyFavoriteAddition>,
  maxFavorites: number,
): void {
  if (result.addedModels.length === 1) {
    const model = result.addedModels[0]!;
    p.log.success(`Added ${model.name || model.id} (${addition.provider.name}) to favorites.`);
  } else if (result.addedModels.length > 1) {
    p.log.success(`Added ${result.addedModels.length} models from ${addition.provider.name} to favorites.`);
  }
  if (result.duplicateCount > 0) {
    p.log.warn(`${result.duplicateCount} selected model(s) were already in your favorites.`);
  }
  if (result.limitReached) {
    p.log.warn(`Limit of ${maxFavorites} favorites reached — some selected models could not be added.`);
  }
}

export async function runModelsCommand(opts: FavoritesCommandOptions = {}): Promise<number> {
  const changesAlias = opts.alias !== undefined || opts.unalias !== undefined;
  if (changesAlias && (opts.list || (opts.alias !== undefined && opts.unalias !== undefined))) {
    p.log.error('--alias/--unalias apply one at a time to proxy-mode favorites.');
    return 1;
  }
  if (opts.alias !== undefined) {
    const parsed = parseModelAliasAssignment(opts.alias);
    if ('error' in parsed) {
      p.log.error(parsed.error);
      return 1;
    }
    const prefs = loadPreferences();
    const isSavedFavorite = (prefs.favoriteModels ?? []).some(
      favorite => favorite.providerId === parsed.providerId && favorite.modelId === parsed.modelId,
    );
    if (!isSavedFavorite) {
      p.log.error(`${modelAliasTarget(parsed)} is not a saved favorite.`);
      p.log.info('Add it with `clodex models`, then save the alias.');
      return 1;
    }
    if (prefs.modelAliases !== undefined && !Array.isArray(prefs.modelAliases)) {
      p.log.error('Saved model aliases are malformed: "modelAliases" must be an array.');
      return 1;
    }
    const aliases = prefs.modelAliases ?? [];
    const modelAliases = aliases.filter(alias => !modelAliasMatchesName(alias, parsed.name));
    modelAliases.push(parsed);
    savePreferences({ modelAliases });
    p.log.success(`Saved model alias ${parsed.name} → ${modelAliasTarget(parsed)}.`);
    return 0;
  }
  if (opts.unalias !== undefined) {
    const requestedName = opts.unalias.trim();
    const name = canonicalModelAliasName(requestedName);
    const prefs = loadPreferences();
    if (prefs.modelAliases !== undefined && !Array.isArray(prefs.modelAliases)) {
      p.log.error('Saved model aliases are malformed: "modelAliases" must be an array.');
      return 1;
    }
    const aliases = prefs.modelAliases ?? [];
    const modelAliases = aliases.filter(alias => !modelAliasMatchesStoredName(alias, requestedName));
    const removedCount = aliases.length - modelAliases.length;
    if (removedCount === 0) {
      p.log.error(`No model alias named ${JSON.stringify(requestedName)} is saved.`);
      return 1;
    }
    savePreferences({ modelAliases });
    p.log.success(
      removedCount === 1
        ? `Removed model alias ${name || JSON.stringify(requestedName)}.`
        : `Removed ${removedCount} model aliases named ${name || JSON.stringify(requestedName)}.`,
    );
    return 0;
  }
  if (opts.list) {
    try {
      const loaded = await loadHttpProxyRoutes();
      printHttpProxyModels(loaded.routes, loaded.aliases);
      reportSkippedHttpProxyFavorites(loaded);
      return 0;
    } catch (err) {
      p.log.error(`Could not load proxy models: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const maxFavorites = MAX_MODEL_CATALOG;
  const scopeName = 'Favorite Models';
  relayIntro(scopeName);

  const spinner = p.spinner();
  spinner.start('Loading providers...');

  const catalog = await fetchProviderCatalog();
  spinner.stop('');

  const allProviders = providersForPicker(catalog);
  const favoriteProviders = allProviders.map(provider => ({
    ...provider,
    name: favoriteProviderDisplayName(provider),
  }));

  if (favoriteProviders.length === 0) {
    p.log.warn('No providers found.');
    p.log.info(`${pc.dim('Add a provider with ')}${pc.cyan('clodex providers')}${pc.dim('./')}`);
    relayOutro('Done');
    return 0;
  }

  // Build a flat name lookup: "providerId:modelId" → display label
  const modelLookup = new Map<string, { modelName: string; providerName: string }>();
  for (const ap of favoriteProviders) {
    for (const m of ap.models) {
      modelLookup.set(`${ap.id}:${m.id}`, { modelName: m.name || m.id, providerName: ap.name });
    }
  }

  const prefs = loadPreferences();
  let favorites = prefs.favoriteModels ?? [];
  let favoritesDirty = false;


  while (true) {
    type MenuChoice = string;
    const options: Array<{ value: MenuChoice; label: string; hint: string }> = [];

    // One entry per saved favorite; selecting it removes it
    for (let i = 0; i < favorites.length; i++) {
      const fav = favorites[i]!;
      const entry = modelLookup.get(`${fav.providerId}:${fav.modelId}`);
      const label = entry
        ? `${fmtEnabledStar(true)} ${fmtModel(entry.modelName)} ${pc.dim(`(${entry.providerName})`)}`
        : pc.dim(`★ ${fav.modelId} — provider gone`);
      options.push({ value: `fav-${i}`, label, hint: 'select to remove' });
    }

    const atCap = favorites.length >= maxFavorites;
    options.push({
      value: '__add__',
      label: atCap ? pc.dim(`+ Add a model → (limit of ${maxFavorites} reached)`) : pc.cyan('+ Add a model →'),
      hint: atCap
        ? 'Remove a favorite first to make room'
        : `${allProviders.length} provider${allProviders.length !== 1 ? 's' : ''} available`,
    });
    options.push({ value: '__done__', label: 'Done', hint: '' });

    const header = favorites.length === 0
      ? `${scopeName} (0/${maxFavorites})`
      : `${scopeName} (${favorites.length}/${maxFavorites}) — select to remove`;

    const choice = await p.select<string>({
      message: header,
      options,
      initialValue: '__done__',
    });

    if (p.isCancel(choice) || choice === '__done__') break;

    if (choice === '__add__') {
      if (atCap) {
        p.log.warn(`Limit of ${maxFavorites} favorites reached — remove one first.`);
        continue;
      }

      const addition = await selectFavoriteAddition(favoriteProviders, favorites);
      if (!addition) continue;
      const result = applyFavoriteAddition(favorites, addition, maxFavorites);
      favorites = result.favorites;
      favoritesDirty ||= result.addedModels.length > 0;
      reportFavoriteAddition(addition, result, maxFavorites);
    } else if ((choice).startsWith('fav-')) {
      const idx = parseInt((choice).slice(4), 10);
      const fav = favorites[idx]!;
      const entry = modelLookup.get(`${fav.providerId}:${fav.modelId}`);
      const label = entry ? `${entry.modelName} (${entry.providerName})` : fav.modelId;
      const confirmed = await p.confirm({ message: `Remove ${label} from favorites?` });
      if (p.isCancel(confirmed) || !confirmed) continue;
      favorites = removeFavorite(favorites, fav);
      favoritesDirty = true;
      p.log.success(`Removed ${label} from favorites.`);
    }
  }

  if (favoritesDirty) {
    savePreferences({ favoriteModels: favorites });
  }

  relayOutro(
    favorites.length === 0
      ? 'No favorites saved'
      : `${favorites.length} favorite${favorites.length !== 1 ? 's' : ''} saved`,
    favorites.length === 0
      ? pc.dim('Launch uses single-model mode')
      : pc.cyan('/model menu ready on next launch'),
  );
  return 0;
}
