// src/registry/refresh-models.ts — user-initiated model list refresh per modelSource

import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import { isDeepStrictEqual } from 'node:util';
import { fetchAnthropicModels } from './custom-endpoint.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistryStrict, saveRegistry } from './io.js';
import { withRegistryWriteLock } from './lock.js';
import { resolveModelSource } from './model-source.js';
import { validateCustomEndpointUrl } from './url-security.js';
import {
  effectiveProviderBaseUrl,
  resolveProviderTemplate,
  syntheticTemplate,
} from './resolve-template.js';
import {
  buildPricingIndex,
  enrichModelsWithPricing,
  enrichPricingAsync,
  loadPricingCache,
  pricingPlatformForProvider,
} from './pricing.js';
import { cachedModelCount, isLikelyPlaceholderKey, resolveRefreshCredential, skipWithCachedModels } from './refresh-credentials.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import {
  buildOpenAiOAuthModels,
  OPENAI_MILLION_CONTEXT_MODELS,
  OPENAI_MILLION_CONTEXT_WINDOW,
  OPENAI_OAUTH_RETIRED_MODELS,
} from '../data/openai-oauth-models.js';
import { modelPrefersResponsesApi } from '../provider-factory.js';
import { deriveBrand } from '../models/types.js';
import { resolveContextWindow } from '../models/context-window.js';
import { requireChatGptPlanToken } from '../oauth/openai.js';
import { classifyFreeStatus, isFreeStatus } from '../models/free-models.js';
import { PROVIDER_METADATA_TIMEOUT_MS } from '../config/timeouts.js';
import { diagnosticRecord } from '../observability/trace-log.js';
import type { DiagnosticRecord } from '../observability/trace-log.js';

export interface RefreshProviderResult {
  id: string;
  name: string;
  ok: boolean;
  modelCount?: number;
  previousModelCount?: number;
  skipped?: boolean;
  reason?: string;
}

export interface RefreshModelsResult {
  refreshed: RefreshProviderResult[];
}

/** A parsed model entry, including backend-reported request capability flags. */
interface OpenAiModelEntry {
  id: string;
  name: string;
  context_window?: number;
}

interface OpenAiModelPayload {
  value: unknown;
}

function optionalString(record: DiagnosticRecord, key: string): string | undefined {
  const value = record[key];
  return isString(value) ? value : undefined;
}

function optionalFiniteNumber(record: DiagnosticRecord, key: string): number | undefined {
  const value = record[key];
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

/** Parse model entries from OpenAI-standard or ChatGPT-internal response shapes. */
function parseOpenAiModelEntries(body: OpenAiModelPayload['value']): OpenAiModelEntry[] {
  if (!body || !isObject(body)) return [];
  const b = diagnosticRecord(body);

  // ChatGPT plan model catalog: { models: [{ slug, display_name, visibility }] }
  if (Array.isArray(b.models)) {
    return b.models
      .filter(isObject)
      .map(diagnosticRecord)
      .filter(m => m.visibility === 'list')
      .map(m => ({
        id: optionalString(m, 'slug') ?? '',
        name: optionalString(m, 'display_name') ?? optionalString(m, 'slug') ?? '',
        context_window: optionalFiniteNumber(m, 'context_window'),
      }))
      .filter(m => m.id.length > 0);
  }
  // Standard OpenAI format: { data: [{ id, name }] }
  if (Array.isArray(b.data)) {
    return b.data
      .filter(isObject)
      .map(diagnosticRecord)
      .map(m => ({
        id: optionalString(m, 'id') ?? '',
        name: optionalString(m, 'name') ?? optionalString(m, 'id') ?? '',
        context_window: optionalFiniteNumber(m, 'context_window'),
      }))
      .filter(m => m.id.length > 0);
  }
  return [];
}

/**
 * Build a CachedModel for a discovered OpenAI OAuth model. The live backend is
 * authoritative for context and capability flags: when the model is also seeded,
 * live values are merged over the seed (the seed is only a fallback).
 */
function buildDynamicOAuthModel(entry: OpenAiModelEntry, seedById: Map<string, CachedModel>): CachedModel {
  const seed = seedById.get(entry.id);
  if (seed) {
    // Older backend catalogs can still report the pre-1M 272K value. Do not let
    // that stale metadata downgrade a confirmed million-token route in Claude Code.
    const contextWindow = OPENAI_MILLION_CONTEXT_MODELS.has(entry.id.toLowerCase())
      ? OPENAI_MILLION_CONTEXT_WINDOW
      : entry.context_window ?? seed.contextWindow;
    return {
      ...seed,
      contextWindow,
    };
  }
  const { id } = entry;
  const prefix = id.split('-')[0] ?? id;
  return {
    id,
    name: entry.name,
    upstreamModelId: id,
    family: prefix,
    brand: deriveBrand(prefix),
    contextWindow: entry.context_window ?? resolveContextWindow(id),
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai',
    reasoning: modelPrefersResponsesApi(id),
  };
}

/** Fetch and parse JSON from a URL with auth and timeout, returning null on any failure. */
async function fetchJsonWithAuth(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<{ body: unknown; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      const detail = await response.text().then(t => t.slice(0, 200)).catch(() => '');
      return { body: null, error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
    }
    return { body: await response.json() };
  } catch (err) {
    return { body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch the selected ChatGPT registration's public model catalog.
 */
async function refreshOpenAiOAuthModels(
  accessToken: string,
): Promise<{ models: CachedModel[]; source: 'live' }> {
  requireChatGptPlanToken(accessToken);
  const seedById = new Map(buildOpenAiOAuthModels().map(m => [m.id, m]));
  const result = await fetchJsonWithAuth('https://api.openai.com/v1/models', accessToken, PROVIDER_METADATA_TIMEOUT_MS);
  if (result.error) throw new Error(`ChatGPT model discovery failed: ${result.error}`);
  const models = parseOpenAiModelEntries(result.body)
    .filter(({ id }) => !OPENAI_OAUTH_RETIRED_MODELS.has(id.toLowerCase()))
    .map(entry => buildDynamicOAuthModel(entry, seedById));
  // Sol 6.1 accepts direct plan requests before /v1/models lists it.
  const sol = seedById.get('gpt-6.1-sol')!;
  if (!models.some(model => model.id === sol.id)) models.unshift(sol);
  return { models, source: 'live' };
}

async function refreshApiListProvider(
  provider: RegistryProvider,
  apiKey: string,
): Promise<{ models: CachedModel[]; baseUrl?: string; error?: string }> {
  const npm = provider.api.npm ?? '@ai-sdk/openai-compatible';
  const catalogTemplate = resolveProviderTemplate(provider);
  const baseUrl = effectiveProviderBaseUrl(provider, catalogTemplate);

  if (!baseUrl) {
    return { models: [], error: 'Provider has no API base URL configured.' };
  }

  let safeBaseUrl = baseUrl;
  const configuredUrl = provider.api.url?.trim();
  const templateDefault = catalogTemplate?.defaultBaseUrl?.trim();
  if (configuredUrl && configuredUrl !== templateDefault) {
    const urlCheck = await validateCustomEndpointUrl(baseUrl, {
      allowInsecureLocal: catalogTemplate?.apiKeyOptional === true,
    });
    if (!urlCheck.ok || !urlCheck.normalizedUrl) {
      return { models: [], error: `${urlCheck.error ?? 'Invalid API base URL.'} ${urlCheck.hint ?? ''}`.trim() };
    }
    safeBaseUrl = urlCheck.normalizedUrl;
  }

  const template = catalogTemplate ?? syntheticTemplate(provider, safeBaseUrl);

  if (npm === '@ai-sdk/anthropic') {
    const fetched = await fetchAnthropicModels(safeBaseUrl, apiKey);
    if (fetched.error || fetched.models.length === 0) {
      return { models: [], error: fetched.error ?? 'No models returned.', baseUrl: fetched.baseUrl };
    }
    return {
      models: fetched.models.map(m => ({ ...m, apiUrl: fetched.baseUrl })),
      baseUrl: fetched.baseUrl,
    };
  }

  const fetched = await fetchTemplateModels(template, apiKey, safeBaseUrl);
  if (fetched.error || fetched.models.length === 0) {
    return { models: [], error: fetched.error ?? 'No models returned.' };
  }
  const usableModels = !apiKey.trim() && template.anonymousFreeModels
    ? fetched.models.filter(model => isFreeStatus(classifyFreeStatus({
        model,
        providerId: provider.id,
        templateId: provider.templateId,
      })))
    : fetched.models;
  if (usableModels.length === 0) {
    return { models: [], error: 'No free models were returned for anonymous access.' };
  }

  return {
    models: usableModels.map(m => Object.assign({}, m, { apiUrl: fetched.baseUrl })),
    baseUrl: fetched.baseUrl,
  };
}

function updateProviderCache(
  registry: ProviderRegistry,
  providerId: string,
  models: CachedModel[],
  baseUrl?: string,
): void {
  const idx = registry.providers.findIndex(p => p.id === providerId);
  if (idx < 0) return;
  const now = new Date().toISOString();
  const existing = registry.providers[idx]!;
  registry.providers[idx] = {
    ...existing,
    refreshedAt: now,
    api: baseUrl ? { ...existing.api, url: baseUrl } : existing.api,
    modelsCache: {
      fetchedAt: now,
      models,
    },
  };
}

function providerDiscoveryInputsMatch(
  current: RegistryProvider,
  started: RegistryProvider,
): boolean {
  return current.authRef === started.authRef
    && current.authType === started.authType
    && current.templateId === started.templateId
    && isDeepStrictEqual(current.api, started.api);
}

export async function refreshProviderModels(
  providerId: string,
  apiKey: string | null,
  registry?: ProviderRegistry,
): Promise<RefreshProviderResult> {
  const workingRegistry = registry ?? loadRegistryStrict();
  const provider = workingRegistry.providers.find(p => p.id === providerId);
  if (!provider) {
    return { id: providerId, name: providerId, ok: false, reason: 'Provider not found.' };
  }

  const source = resolveModelSource(provider);
  if (source === 'manual-only') {
    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      skipped: true,
      reason: 'Manual-only provider — model list is not refreshed automatically.',
    };
  }

  try {
    const previousModelCount = provider.modelsCache?.models.length ?? 0;
    let models: CachedModel[] = [];
    let baseUrl: string | undefined;

    if (provider.authType === 'oauth' && (
      provider.templateId === 'openai'
      || provider.id === 'openai-oauth'
    )) {
      // Discover models authorized for this ChatGPT plan grant.
      if (!apiKey) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'OAuth token not available — try signing in again with clodex providers auth.',
        };
      }
      models = (await refreshOpenAiOAuthModels(apiKey)).models;
      if (models.length === 0) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'No models available for this OAuth provider — try signing in again.',
        };
      }
    } else {
      const template = resolveProviderTemplate(provider);
      const keyOptional = template?.apiKeyOptional === true;
      const effectiveKey = keyOptional && isLikelyPlaceholderKey(apiKey) ? '' : apiKey;
      if (!keyOptional && isLikelyPlaceholderKey(effectiveKey)) {
        if (cachedModelCount(provider) > 0) {
          return skipWithCachedModels(
            provider,
            'A placeholder API key is configured — kept cached model list. '
            + 'Add this provider again via clodex providers add with a real key to refresh live.',
          );
        }
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'No usable API key — add the provider via clodex providers add with a real key.',
        };
      }
      if (!keyOptional && !effectiveKey) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'API key not available — cannot refresh models.',
        };
      }
      const fetched = await refreshApiListProvider(provider, effectiveKey ?? '');
      if (fetched.error) {
        if (
          (fetched.error.includes('rejected') || fetched.error.includes('401') || fetched.error.includes('403'))
          && cachedModelCount(provider) > 0
        ) {
          return skipWithCachedModels(
            provider,
            `${fetched.error} Kept ${cachedModelCount(provider)} cached model${cachedModelCount(provider) === 1 ? '' : 's'} from import. `
            + 'Update your API key via clodex providers add if you need a live refresh.',
          );
        }
        return { id: provider.id, name: provider.name, ok: false, reason: fetched.error };
      }
      models = fetched.models;
      baseUrl = fetched.baseUrl;
    }

    const pricingCache = loadPricingCache();
    const platform = pricingPlatformForProvider(provider.templateId, provider.id);
    const enriched = enrichModelsWithPricing(models, buildPricingIndex(pricingCache), platform);

    await withRegistryWriteLock(() => {
      const currentRegistry = loadRegistryStrict();
      const currentProvider = currentRegistry.providers.find(candidate => candidate.id === providerId);
      if (!currentProvider) throw new Error('Provider was removed while models were refreshing.');
      if (currentProvider.authRef !== provider.authRef) {
        throw new Error('Provider credentials changed while models were refreshing.');
      }
      if (!providerDiscoveryInputsMatch(currentProvider, provider)) {
        throw new Error('Provider configuration changed while models were refreshing.');
      }
      updateProviderCache(currentRegistry, providerId, enriched, baseUrl);
      saveRegistry(currentRegistry);
    });
    enrichPricingAsync();

    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      modelCount: enriched.length,
      previousModelCount: provider.refreshedAt ? previousModelCount : undefined,
    };
  } catch (err) {
    return {
      id: provider.id,
      name: provider.name,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refreshAllProviderModels(
  resolveKey: (provider: RegistryProvider) => Promise<string | null>,
): Promise<RefreshModelsResult> {
  const refreshed: RefreshProviderResult[] = [];
  const registry = loadRegistryStrict();

  const enabledProviders = registry.providers.filter(p => p.enabled);

  for (const provider of enabledProviders) {
    const key = await resolveRefreshCredential(provider, resolveKey);
    refreshed.push(await refreshProviderModels(provider.id, key));
  }

  return { refreshed };
}
