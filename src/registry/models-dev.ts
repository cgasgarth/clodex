// src/registry/models-dev.ts — models.dev capability cache (bundled + optional user refresh)

import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import bundledCache from '../data/models-dev-cache.json';
import { getAppHome } from '../config/paths.js';
import { PROVIDER_METADATA_TIMEOUT_MS } from '../config/timeouts.js';
import { normalizeModelIdCandidates } from './pricing.js';
import { diagnosticRecord } from '../observability/trace-log.js';

const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = PROVIDER_METADATA_TIMEOUT_MS;
const FILE_MODE = 0o600;

interface ModelsDevModalities {
  input?: string[];
  output?: string[];
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  tool_call?: boolean;
  chat?: boolean;
  interactions?: boolean;
  reasoning?: boolean;
  interleaved?: { field?: string };
  modalities?: ModelsDevModalities;
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

export interface ModelsDevCacheFile {
  [providerId: string]: ModelsDevProvider | ModelsDevCacheMeta;
}

interface ModelsDevProviderCache {
  [providerId: string]: ModelsDevProvider;
}

interface ModelsDevPayload {
  value: object;
}

export interface ModelsDevCacheMeta {
  schema_version?: string;
  fetched_at?: string;
  source?: string;
  provider_count?: number;
}

const META_KEY = '_relay_meta';

interface RegistryModelsDevMap {
  [providerId: string]: string;
}

let memoryCache: ModelsDevCacheFile | null = null;
let memoryCachePath: string | null = null;
let memoryCacheMtime = 0;

/** Registry / OpenCode provider id → models.dev top-level key */
const REGISTRY_TO_MODELS_DEV: RegistryModelsDevMap = {
  openai: 'openai',
  groq: 'groq',
  mistral: 'mistral',
  togetherai: 'together',
  cerebras: 'cerebras',
  deepinfra: 'deepinfra',
  'xai-oauth': 'xai',
  perplexity: 'perplexity',
  cohere: 'cohere',
  alibaba: 'alibaba',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  nvidia: 'nvidia',
  venice: 'openrouter',
};

export function readModelsDevCacheMeta(
  cache: ModelsDevCacheFile,
): ModelsDevCacheMeta | null {
  const raw = cache[META_KEY];
  if (!raw || !isObject(raw)) return null;
  const fields = diagnosticRecord(raw);
  const meta: ModelsDevCacheMeta = {};
  if (isString(fields.schema_version)) meta.schema_version = fields.schema_version;
  if (isString(fields.fetched_at)) meta.fetched_at = fields.fetched_at;
  if (isString(fields.source)) meta.source = fields.source;
  if (isNumber(fields.provider_count)) meta.provider_count = fields.provider_count;
  return meta;
}

export function stripModelsDevCacheMeta(cache: ModelsDevCacheFile): ModelsDevProviderCache {
  const providers: ModelsDevProviderCache = {};
  for (const [key, value] of Object.entries(cache)) {
    if (key === META_KEY) continue;
    const provider: ModelsDevProvider = {};
    Object.assign(provider, value);
    providers[key] = provider;
  }
  return providers;
}

function modelsDevProviderCache(value: ModelsDevPayload['value']): ModelsDevProviderCache {
  const cache: ModelsDevProviderCache = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || !isObject(entry) || Array.isArray(entry)) continue;
    const provider: ModelsDevProvider = {};
    Object.assign(provider, entry);
    cache[key] = provider;
  }
  return cache;
}

export function loadBundledModelsDevCache(): ModelsDevCacheFile {
  return modelsDevProviderCache(bundledCache);
}

function invalidateModelsDevCache(): void {
  memoryCache = null;
  memoryCachePath = null;
  memoryCacheMtime = 0;
}

function readModelsDevFile(path: string): ModelsDevCacheFile | null {
  if (!existsSync(path)) return null;
  try {
    const cache: ModelsDevCacheFile = JSON.parse(readFileSync(path, 'utf8'));
    return cache;
  } catch {
    return null;
  }
}

function mkdirSafe(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }
}

function attachModelsDevCacheMeta(
  providers: ModelsDevProviderCache,
): ModelsDevCacheFile {
  const providerCount = Object.keys(providers).filter(k => !k.startsWith('_')).length;
  return Object.fromEntries([
    [META_KEY, {
      schema_version: '1',
      fetched_at: new Date().toISOString(),
      source: MODELS_DEV_API_URL,
      provider_count: providerCount,
    }],
    ...Object.entries(providers),
  ]);
}

function writeModelsDevCache(path: string, data: ModelsDevCacheFile): void {
  mkdirSafe(dirname(path));
  writeFileSync(path, `${JSON.stringify(data)}\n`, { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // best-effort
  }
  invalidateModelsDevCache();
}

function getUserModelsDevCachePath(): string {
  return join(getAppHome(), 'models-dev-cache.json');
}

function rememberModelsDevCache(path: string, data: ModelsDevCacheFile): ModelsDevCacheFile {
  memoryCache = data;
  memoryCachePath = path;
  try {
    memoryCacheMtime = statSync(path).mtimeMs;
  } catch {
    memoryCacheMtime = 0;
  }
  return data;
}

export function loadModelsDevCache(): ModelsDevCacheFile {
  const userPath = getUserModelsDevCachePath();
  if (existsSync(userPath)) {
    try {
      const mtime = statSync(userPath).mtimeMs;
      if (memoryCache && memoryCachePath === userPath && memoryCacheMtime === mtime) {
        return memoryCache;
      }
      const data = readModelsDevFile(userPath);
      if (data) return rememberModelsDevCache(userPath, data);
    } catch {
      // fall through to bundled
    }
  }

  if (memoryCache && memoryCachePath === 'bundled') return memoryCache;
  return rememberModelsDevCache('bundled', loadBundledModelsDevCache());
}

async function fetchModelsDevCache(): Promise<ModelsDevCacheFile | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const raw = await response.json();
    if (!raw || !isObject(raw) || Array.isArray(raw)) return null;
    const data = modelsDevProviderCache(raw);
    const withMeta = attachModelsDevCacheMeta(data);
    writeModelsDevCache(getUserModelsDevCachePath(), withMeta);
    return withMeta;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resolveModelsDevSlug(providerId: string): string {
  return REGISTRY_TO_MODELS_DEV[providerId] ?? providerId;
}

/** Fetch latest models.dev catalog in the background; falls back to bundled snapshot offline. */
export function refreshModelsDevCacheAsync(onComplete?: (updated: boolean) => void): void {
  void (async () => {
    const updated = (await fetchModelsDevCache()) !== null;
    onComplete?.(updated);
  })();
}

export function findModelsDevModel(
  providerId: string,
  modelId: string,
  cache: ModelsDevCacheFile = loadModelsDevCache(),
): ModelsDevModel | null {
  const slug = resolveModelsDevSlug(providerId);
  const models = stripModelsDevCacheMeta(cache)[slug]?.models;
  if (!models) return null;

  for (const candidate of normalizeModelIdCandidates(modelId)) {
    const entry = models[candidate];
    if (entry) return entry;
  }
  return null;
}

/** Conservative auto-hide rules — only when models.dev row exists and fields are explicit. */
export function shouldHideByModelsDevCapabilities(entry: ModelsDevModel): boolean {
  const output = entry.modalities?.output;
  if (output && output.length > 0 && !output.includes('text')) return true;
  if (entry.tool_call === false) return true;
  if (entry.interactions === true && entry.chat === false) return true;
  return false;
}
