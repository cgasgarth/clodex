import { randomUUID } from 'node:crypto';
import type { ProviderDataValue } from '../types.js';
import {
  isBoolean,
  isNumber,
  isObject,
  isString,
} from '../runtime/type-guards.js';
import {
  deleteCredentialHelperAccount,
  isCredentialAccountInstance,
  readCredentialHelperAccount,
  writeCredentialHelperAccount,
} from './helper.js';
import {
  oauthCredentialToKeychainJson,
  parseStoredOAuthCredential,
  type StoredOAuthCredential,
} from '../oauth/types.js';
import { refreshStoredOAuthCredential, oauthCredentialShouldRefresh } from '../oauth/refresh.js';
import { withCredentialMutationLock } from '../registry/lock.js';
import {
  clodexKeyEnvVar,
  parseAuthRef,
  type ParsedAuthRef,
  type ResolveCredentialOptions,
} from './keyring-account.js';
import { oauthProviderIdFromAccount, oauthRefreshInflight, OAUTH_CREDENTIAL_CACHE_MAX_AGE_MS, oauthCredentialCache, OAUTH_REFRESH_LOCK_WAIT_MS, OAUTH_STATE_KEY_SEPARATOR, readEnvCredential, usableEnvCredential } from './keyring/base.js';
import type { CachedOAuthCredential } from './keyring/base.js';
import { readKeyringAccount, writeKeyringAccount, deleteKeyringAccount } from './keyring/managed.js';

export {
  clodexKeyEnvVar,
  parseAuthRef,
  providerKeyringAccount,
  type ResolveCredentialOptions,
} from './keyring-account.js';
export { classifyKeyringError } from './keyring/base.js';

type StoredCredentialRef = Extract<ParsedAuthRef, { kind: 'keyring' | 'helper' }>;

function storedCredentialAuthRef(ref: StoredCredentialRef): string {
  return ref.kind === 'helper'
    ? `helper:v1:${ref.helperId}:${ref.account}`
    : `keyring:${ref.account}`;
}

async function readStoredCredential(
  ref: StoredCredentialRef,
  diag?: (msg: string) => void,
): Promise<string | null> {
  if (ref.kind === 'keyring') return readKeyringAccount(ref.account, diag);
  try {
    return await readCredentialHelperAccount(ref.account, ref.helperId);
  } catch (err) {
    diag?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function writeStoredCredential(
  ref: StoredCredentialRef,
  value: string,
  intent: 'probe' | 'provision' | 'replace',
  diag?: (msg: string) => void,
): Promise<boolean> {
  if (ref.kind === 'keyring') {
    return writeKeyringAccount(ref.account, value, intent, diag);
  }
  try {
    await writeCredentialHelperAccount(ref.account, value, ref.helperId);
    return true;
  } catch (err) {
    diag?.(err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function deleteStoredCredential(
  ref: StoredCredentialRef,
  diag?: (msg: string) => void,
  blockLegacy = true,
): Promise<boolean> {
  if (ref.kind === 'keyring') {
    return deleteKeyringAccount(ref.account, diag, blockLegacy);
  }
  try {
    await deleteCredentialHelperAccount(ref.account, ref.helperId);
    return true;
  } catch (err) {
    diag?.(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Resolve a provider secret from a namespaced env var or its configured store. */
export async function resolveProviderCredential(
  providerId: string,
  authRef: string,
  diag?: (msg: string) => void,
  options: ResolveCredentialOptions = {},
): Promise<string | null> {
  const parsed = parseAuthRef(authRef);
  if (parsed?.kind === 'none') return null;

  const namespacedVar = clodexKeyEnvVar(providerId);
  const namespaced = usableEnvCredential(
    `provider:${providerId}`,
    readEnvCredential(namespacedVar),
    options.rejectedAccessToken,
  );
  if (namespaced) return namespaced;

  if (!parsed) return null;

  if (parsed.kind === 'env') {
    return usableEnvCredential(
      `provider:${providerId}:env:${parsed.varName}`,
      readEnvCredential(parsed.varName),
      options.rejectedAccessToken,
    );
  }

  return readProviderSecret(parsed, diag, options.rejectedAccessToken);
}

/** Read OAuth metadata retained alongside the access token. */
export async function resolveProviderOAuthAccountId(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<string | undefined> {
  const parsed = parseAuthRef(authRef);
  if (
    !parsed
    || parsed.kind === 'env'
    || parsed.kind === 'none'
    || !oauthProviderIdFromAccount(parsed.account)
  ) return undefined;
  const raw = await readStoredCredential(parsed, diag);
  return parseStoredOAuthCredential(raw)?.accountId;
}

export async function resolveProviderOAuthProviderData(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<Record<string, ProviderDataValue> | undefined> {
  const parsed = parseAuthRef(authRef);
  if (
    !parsed
    || parsed.kind === 'env'
    || parsed.kind === 'none'
    || !oauthProviderIdFromAccount(parsed.account)
  ) return undefined;
  const raw = await readStoredCredential(parsed, diag);
  const providerData = parseStoredOAuthCredential(raw)?.providerData;
  if (!providerData) return undefined;
  const normalized: Record<string, ProviderDataValue> = {};
  for (const [key, value] of Object.entries(providerData)) {
    const parsedValue = parseProviderDataValue(value);
    if (parsedValue === undefined) return undefined;
    normalized[key] = parsedValue;
  }
  return normalized;
}

function parseProviderDataValue<Value>(value: Value): ProviderDataValue | undefined {
  if (value === null) return null;
  if (isString(value)) return value;
  if (isBoolean(value)) return value;
  if (isNumber(value)) return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const values: ProviderDataValue[] = [];
    for (const entry of value) {
      const parsed = parseProviderDataValue(entry);
      if (parsed === undefined) return undefined;
      values.push(parsed);
    }
    return values;
  }
  if (!isObject(value)) return undefined;
  const record: Record<string, ProviderDataValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parseProviderDataValue(entry);
    if (parsed === undefined) return undefined;
    record[key] = parsed;
  }
  return record;
}

function decodeProviderSecret(raw: string | null, allowOpaqueJson = false): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const oauth = parseStoredOAuthCredential(trimmed);
  if (oauth) return oauth.access;
  try {
    // SAFETY: Only the named optional credential fields are read and validated below.
    const parsed = JSON.parse(trimmed) as { type?: string; access?: string; token?: string };
    if (parsed.type === 'wellknown') {
      return isString(parsed.token) && parsed.token.trim()
        ? parsed.token.trim()
        : null;
    }
    if (allowOpaqueJson && parsed.type === 'oauth') {
      return isString(parsed.access) && parsed.access.trim()
        ? parsed.access.trim()
        : null;
    }
    return allowOpaqueJson ? raw : null;
  } catch {
    return null;
  }
}

function oauthCredentialStateKey(providerId: string, authRef: string): string {
  return `${providerId}${OAUTH_STATE_KEY_SEPARATOR}${authRef}`;
}

function clearOAuthCredentialCache(authRef: string): void {
  const suffix = `${OAUTH_STATE_KEY_SEPARATOR}${authRef}`;
  for (const key of oauthCredentialCache.keys()) {
    if (key.endsWith(suffix)) oauthCredentialCache.delete(key);
  }
}

function cacheOAuthCredential(
  stateKey: string,
  credential: StoredOAuthCredential,
): void {
  const cached: CachedOAuthCredential = {
    access: credential.access,
    expires: credential.expires,
    checkedAt: Date.now(),
  };
  if (credential.accessRejected === true) cached.accessRejected = true;
  oauthCredentialCache.set(stateKey, cached);
}

function cachedOAuthCredentialIsUsable(
  credential: CachedOAuthCredential | undefined,
  providerId: string,
  rejectedAccessToken?: string,
): boolean {
  if (!credential) return false;
  const age = Date.now() - credential.checkedAt;
  return age >= 0
    && age < OAUTH_CREDENTIAL_CACHE_MAX_AGE_MS
    && credential.access !== rejectedAccessToken
    && credential.accessRejected !== true
    && !oauthCredentialShouldRefresh(credential, providerId);
}

async function readOAuthProviderSecret(
  ref: StoredCredentialRef,
  providerId: string,
  diag?: (msg: string) => void,
  rejectedAccessToken?: string,
): Promise<string | null> {
  const authRef = storedCredentialAuthRef(ref);
  const stateKey = oauthCredentialStateKey(providerId, authRef);
  const existing = oauthRefreshInflight.get(stateKey);
  if (existing) {
    const resolved = await existing;
    if (resolved !== rejectedAccessToken) return resolved;
    return readOAuthProviderSecret(ref, providerId, diag, rejectedAccessToken);
  }

  const cached = oauthCredentialCache.get(stateKey);
  if (cached && cachedOAuthCredentialIsUsable(cached, providerId, rejectedAccessToken)) {
    return cached.access;
  }
  if (cached?.access === rejectedAccessToken) oauthCredentialCache.delete(stateKey);

  const work = withCredentialMutationLock(authRef, async (): Promise<string | null> => {
    const latestCached = oauthCredentialCache.get(stateKey);
    if (
      latestCached
      && cachedOAuthCredentialIsUsable(latestCached, providerId, rejectedAccessToken)
    ) {
      return latestCached.access;
    }

    for (let generation = 0; generation < 3; generation += 1) {
      const raw = await readStoredCredential(ref, diag);
      if (!raw) return null;

      const cred = parseStoredOAuthCredential(raw);
      if (!cred) {
        const decoded = decodeProviderSecret(raw);
        return decoded === rejectedAccessToken ? null : decoded;
      }
      cacheOAuthCredential(stateKey, cred);

      const forceRefresh = cred.access === rejectedAccessToken || cred.accessRejected === true;
      if (!forceRefresh && !oauthCredentialShouldRefresh(cred, providerId)) {
        return cred.access;
      }

      let refreshed;
      try {
        refreshed = await refreshStoredOAuthCredential(providerId, cred);
      } catch (err) {
        diag?.(err instanceof Error ? err.message : String(err));
        if (!forceRefresh && cred.access && cred.expires > Date.now()) return cred.access;
        oauthCredentialCache.delete(stateKey);
        throw err;
      }

      const accessStillRejected = (
        rejectedAccessToken !== undefined
        && refreshed.access === rejectedAccessToken
      ) || (
        cred.accessRejected === true
        && refreshed.access === cred.access
      );
      const currentRaw = await readStoredCredential(ref, diag);
      if (currentRaw !== raw) {
        oauthCredentialCache.delete(stateKey);
        continue;
      }

      const credentialToSave: StoredOAuthCredential = accessStillRejected
        ? { ...refreshed, accessRejected: true }
        : refreshed;
      const json = oauthCredentialToKeychainJson(credentialToSave);
      const saved = await saveProviderCredential(authRef, json, diag);
      if (!saved) {
        oauthCredentialCache.delete(stateKey);
        throw new Error('Could not persist refreshed OAuth credential');
      }
      if (accessStillRejected) {
        oauthCredentialCache.delete(stateKey);
        return null;
      }
      return refreshed.access;
    }
    throw new Error('OAuth credential changed repeatedly while refresh was in progress');
  }, {
    waitMs: OAUTH_REFRESH_LOCK_WAIT_MS,
  });

  oauthRefreshInflight.set(stateKey, work);
  try {
    return await work;
  } finally {
    if (oauthRefreshInflight.get(stateKey) === work) {
      oauthRefreshInflight.delete(stateKey);
    }
  }
}

async function readProviderSecret(
  ref: StoredCredentialRef,
  diag?: (msg: string) => void,
  rejectedAccessToken?: string,
): Promise<string | null> {
  const oauthProviderId = oauthProviderIdFromAccount(ref.account);
  if (oauthProviderId) {
    return readOAuthProviderSecret(ref, oauthProviderId, diag, rejectedAccessToken);
  }
  const raw = await readStoredCredential(ref, diag);
  const decoded = decodeProviderSecret(raw, true);
  return decoded === rejectedAccessToken ? null : decoded;
}

async function persistProviderCredential(
  authRef: string,
  key: string,
  intent: 'provision' | 'replace',
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === 'env' || parsed.kind === 'none') return false;
  if (intent === 'provision' && !isCredentialAccountInstance(parsed.account)) {
    diag?.('provisioned credentials require a versioned account instance');
    return false;
  }
  return withCredentialMutationLock(authRef, async () => {
    const cacheKey = storedCredentialAuthRef(parsed);
    clearOAuthCredentialCache(cacheKey);
    const written = await writeStoredCredential(parsed, key, intent, diag);
    if (!written) return false;
    const readBack = await readStoredCredential(parsed, diag);
    if (readBack === key) {
      const oauth = parseStoredOAuthCredential(key);
      const oauthProviderId = oauthProviderIdFromAccount(parsed.account);
      if (oauth && oauthProviderId) {
        cacheOAuthCredential(oauthCredentialStateKey(oauthProviderId, cacheKey), oauth);
      }
      return true;
    }
    diag?.('credential store read-back verification failed');
    return false;
  });
}

/** Create or resume a credential at its provider-owned account reference. */
export async function provisionProviderCredential(
  authRef: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  return persistProviderCredential(authRef, key, 'provision', diag);
}

/** Replace a credential whose prior state can be confirmed. */
export async function saveProviderCredential(
  authRef: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  return persistProviderCredential(authRef, key, 'replace', diag);
}

/** Verify that a credential backend can durably round-trip a disposable secret. */
export async function probeProviderCredentialStore(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === 'env' || parsed.kind === 'none') return false;
  const probeAccount = `${parsed.account}::probe::${randomUUID()}`;
  const probeRef: StoredCredentialRef = parsed.kind === 'helper'
    ? { kind: 'helper', helperId: parsed.helperId, account: probeAccount }
    : { kind: 'keyring', account: probeAccount };
  const value = randomUUID();
  let verified = false;
  try {
    const written = await writeStoredCredential(probeRef, value, 'probe', diag);
    if (!written) return false;
    const readBack = await readStoredCredential(probeRef, diag);
    if (readBack !== value) {
      diag?.('credential store probe read-back verification failed');
      return false;
    }
    verified = true;
  } finally {
    const deleted = await deleteStoredCredential(probeRef, diag, false);
    if (!deleted) {
      diag?.('credential store probe cleanup failed');
      verified = false;
    }
  }
  return verified;
}

/** Delete a provider secret from its credential store (no-op for env: refs). */
export async function deleteProviderCredential(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind === 'env' || parsed.kind === 'none') return false;
  return withCredentialMutationLock(authRef, () => {
    clearOAuthCredentialCache(storedCredentialAuthRef(parsed));
    return deleteStoredCredential(parsed, diag);
  });
}
