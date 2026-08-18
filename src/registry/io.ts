// src/registry/io.ts — load/save providers.json with secure permissions

import { isBoolean, isNumber, isObject, isString } from '../runtime/type-guards.js';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getAppHome, getProvidersPath } from '../config/paths.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import { REGISTRY_SCHEMA_VERSION } from './types.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLockSync,
} from './lock.js';
import { migrateOAuthOpenAiProvider } from './migrate.js';
import { isValidProviderId } from './validate.js';
import { diagnosticRecord } from '../observability/trace-log.js';
import type { DiagnosticRecord } from '../observability/trace-log.js';
import type { DiagnosticValue } from '../observability/trace-log.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ensureSecureAppHome(): void {
  const home = getAppHome();
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(home, DIR_MODE);
  } catch {
    // best-effort on platforms that restrict chmod
  }
}

export function writeSecureFile(path: string, content: string): void {
  ensureSecureAppHome();
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const fd = openSync(path, 'wx', FILE_MODE);
  try {
    const payload = Buffer.from(content);
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(fd, payload, offset, payload.length - offset);
      if (written <= 0) {
        throw new Error(`Could not complete secure file write: ${path}`);
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // best-effort
  }
}

export function syncParentDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = isObject(error) && 'code' in error && isString(error.code)
      ? error.code
      : undefined;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseCachedModel(value: DiagnosticValue): CachedModel | null {
  if (!value || !isObject(value) || Array.isArray(value)) return null;
  const fields = diagnosticRecord(value);
  if (!isString(fields.id) || !isString(fields.name)) return null;
  if (
    fields.modelFormat !== 'anthropic'
    && fields.modelFormat !== 'openai'
    && fields.modelFormat !== 'cloud-code'
  ) return null;
  const model: CachedModel = {
    id: fields.id,
    name: fields.name,
    modelFormat: fields.modelFormat,
  };
  Object.assign(model, fields);
  return model;
}

function parseProvider(raw: DiagnosticValue): RegistryProvider | null {
  if (!raw || !isObject(raw)) return null;
  const p = diagnosticRecord(raw);
  if (!isString(p.id) || !isValidProviderId(p.id)) return null;
  if (!isString(p.templateId) || !p.templateId) return null;
  if (!isString(p.name) || !p.name) return null;
  if (!isBoolean(p.enabled)) return null;
  if (!isString(p.authRef) || !p.authRef) return null;
  if (!isString(p.addedAt) || !p.addedAt) return null;
  const api = p.api;
  if (!api || !isObject(api)) return null;
  const apiFields = diagnosticRecord(api);
  const providerApi: RegistryProvider['api'] = {};
  if (isString(apiFields.npm)) providerApi.npm = apiFields.npm;
  if (isString(apiFields.url)) providerApi.url = apiFields.url;
  if (isString(apiFields.id)) providerApi.id = apiFields.id;
  if (apiFields.headers && isObject(apiFields.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(apiFields.headers)) {
      if (isString(value)) headers[key] = value;
    }
    providerApi.headers = headers;
  }

  const provider: RegistryProvider = {
    id: p.id,
    templateId: p.templateId,
    name: p.name,
    enabled: p.enabled,
    authRef: p.authRef,
    api: providerApi,
    addedAt: p.addedAt,
  };

  if (p.subscriptionFilter === 'free') {
    provider.subscriptionFilter = p.subscriptionFilter;
  }
  if (p.authType === 'api' || p.authType === 'oauth' || p.authType === 'none') {
    provider.authType = p.authType;
  }
  if (isString(p.refreshedAt)) provider.refreshedAt = p.refreshedAt;
  if (p.modelsCache && isObject(p.modelsCache)) {
    const cache = diagnosticRecord(p.modelsCache);
    if (isString(cache.fetchedAt) && Array.isArray(cache.models)) {
      const models: CachedModel[] = [];
      for (const model of cache.models) {
        const parsedModel = parseCachedModel(model);
        if (parsedModel) models.push(parsedModel);
      }
      provider.modelsCache = {
        fetchedAt: cache.fetchedAt,
        models,
      };
    }
  }
  return provider;
}

function hasOwn(record: DiagnosticRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasValidStrictProviderFields(raw: DiagnosticValue): boolean {
  if (!raw || !isObject(raw) || Array.isArray(raw)) return false;
  const provider = diagnosticRecord(raw);
  if (hasOwn(provider, 'subscriptionFilter') && provider.subscriptionFilter !== 'free') {
    return false;
  }
  if (
    hasOwn(provider, 'authType')
    && provider.authType !== 'api'
    && provider.authType !== 'oauth'
    && provider.authType !== 'none'
  ) {
    return false;
  }
  if (hasOwn(provider, 'refreshedAt') && !isString(provider.refreshedAt)) {
    return false;
  }
  if (hasOwn(provider, 'modelsCache')) {
    const cache = provider.modelsCache;
    if (!cache || !isObject(cache) || Array.isArray(cache)) return false;
    const fields = diagnosticRecord(cache);
    if (!isString(fields.fetchedAt) || !Array.isArray(fields.models)) {
      return false;
    }
    if (fields.models.some(model => !model || !isObject(model) || Array.isArray(model))) {
      return false;
    }
  }
  return true;
}

function parseRegistry(raw: DiagnosticValue): ProviderRegistry {
  const empty: ProviderRegistry = { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  if (!raw || !isObject(raw)) return empty;
  const data = diagnosticRecord(raw);
  const providers: RegistryProvider[] = [];
  if (Array.isArray(data.providers)) {
    for (const entry of data.providers) {
      const parsed = parseProvider(entry);
      if (parsed) providers.push(parsed);
    }
  }
  const registry: ProviderRegistry = {
    schemaVersion:
      isNumber(data.schemaVersion) ? data.schemaVersion : REGISTRY_SCHEMA_VERSION,
    providers,
  };
  if (isString(data.importedAt)) registry.importedAt = data.importedAt;
  if (isString(data.pricingCacheAt)) registry.pricingCacheAt = data.pricingCacheAt;
  return registry;
}

function parseRegistryStrict(raw: DiagnosticValue): ProviderRegistry {
  if (!raw || !isObject(raw)) {
    throw new Error('Provider registry must be a JSON object.');
  }
  const data = diagnosticRecord(raw);
  if (data.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error('Provider registry has an unsupported schema version.');
  }
  if (!Array.isArray(data.providers)) {
    throw new Error('Provider registry is missing its providers list.');
  }
  for (const entry of data.providers) {
    if (!parseProvider(entry) || !hasValidStrictProviderFields(entry)) {
      throw new Error('Provider registry contains an invalid provider entry.');
    }
  }
  return parseRegistry(raw);
}

function readRegistryStrict(path: string): ProviderRegistry {
  const raw: DiagnosticValue = JSON.parse(readFileSync(path, 'utf8'));
  return parseRegistryStrict(raw);
}

export function loadRegistry(path = getProvidersPath()): ProviderRegistry {
  if (!existsSync(path)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
  try {
    const raw: DiagnosticValue = JSON.parse(readFileSync(path, 'utf8'));
    const registry = parseRegistry(raw);
    const migrated = migrateOAuthOpenAiProvider(registry);
    if (migrated) {
      try {
        withRegistryWriteLockSync(() => {
          if (!existsSync(path)) return;
          const current = readRegistryStrict(path);
          if (migrateOAuthOpenAiProvider(current)) saveRegistry(current, path);
        }, { lockPath: `${path}.lock` });
      } catch {
        // Parsed data remains usable even when migration persistence fails.
      }
    }
    return registry;
  } catch {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
}

/**
 * Load a registry for destructive decisions. Unlike `loadRegistry`, read,
 * parse, and provider-shape errors propagate so callers cannot confuse an
 * unreadable registry with an empty one.
 */
export function loadRegistryStrict(path = getProvidersPath()): ProviderRegistry {
  if (!existsSync(path)) {
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
  }
  const registry = readRegistryStrict(path);
  migrateOAuthOpenAiProvider(registry);
  return registry;
}

export function saveRegistry(
  registry: ProviderRegistry,
  path = getProvidersPath(),
  options: { afterTempWrite?: () => void } = {},
): void {
  assertRegistryWriteOwnership(path);
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  const backup = `${path}.bak`;
  if (existsSync(path)) {
    try {
      copyFileSync(path, backup);
    } catch {
      // backup is best-effort
    }
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeSecureFile(tmp, payload);
    options.afterTempWrite?.();
    assertRegistryWriteOwnership(path);
    renameSync(tmp, path);
    syncParentDirectory(path);
  } finally {
    removeTemporaryRegistryFile(tmp);
  }
}

function removeTemporaryRegistryFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isObject(error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

export function emptyRegistry(): ProviderRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
}
