import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  resolveProviderCredential,
  resolveProviderOAuthAccountId,
} from '../env.js';
import {
  extractOpenAiAccountId,
  extractOpenAiEmail,
} from '../oauth/openai.js';
import type { ProxyRoute } from '../proxy.js';
import { getDaemonTicketKeyPath } from '../paths.js';
import { getTemplateById } from '../provider-templates.js';
import { loadRegistry, loadRegistryStrict, saveRegistry } from '../registry/io.js';
import { withRegistryWriteLockSync } from '../registry/lock.js';
import type { DaemonAccountController, DaemonAccountView } from './control-api.js';
import {
  DaemonAccountStore,
  type DaemonAccountRecord,
  type ManagedOAuthProviderId,
} from './account-store.js';
import {
  fetchOpenAiUsage,
  type OpenAiUsageSnapshot,
} from './openai-usage.js';
import { fetchOpenAiProfileEmail } from './openai-profile.js';
import {
  fetchXaiUsage,
  type XaiUsageSnapshot,
} from './xai-usage.js';

const LAUNCH_TICKET_TTL_MS = 30 * 24 * 60 * 60_000;
const USAGE_REFRESH_MS = 90_000;
const MANAGED_PROVIDER_IDS = ['openai-oauth', 'xai-oauth'] as const;

interface UsageState<T> {
  snapshot?: T;
  fetchedAt?: number;
  error?: string;
}

interface DaemonAccountServiceDependencies {
  resolveCredential: typeof resolveProviderCredential;
  resolveAccountId: typeof resolveProviderOAuthAccountId;
  fetchUsage: typeof fetchOpenAiUsage;
  fetchXaiUsage: typeof fetchXaiUsage;
  fetchEmail: typeof fetchOpenAiProfileEmail;
  now: () => number;
}

const defaultDependencies: DaemonAccountServiceDependencies = {
  resolveCredential: resolveProviderCredential,
  resolveAccountId: resolveProviderOAuthAccountId,
  fetchUsage: fetchOpenAiUsage,
  fetchXaiUsage,
  fetchEmail: fetchOpenAiProfileEmail,
  now: Date.now,
};

export interface LaunchTicket {
  ticket: string;
  accountIds: Partial<Record<ManagedOAuthProviderId, string>>;
  accountLabel: string;
}

export function providerDisplayName(providerId: ManagedOAuthProviderId): string {
  return providerId === 'openai-oauth' ? 'OpenAI (ChatGPT)' : 'xAI (SuperGrok)';
}

function accountIdentity(account: DaemonAccountRecord): string {
  return account.email ?? account.label;
}

function registryTemplateId(providerId: ManagedOAuthProviderId): string {
  return providerId === 'openai-oauth' ? 'openai' : 'xai-oauth';
}

/** Keep the registry bootstrap credential aligned with the selected managed account. */
export function syncManagedProviderCredential(
  providerId: ManagedOAuthProviderId,
  authRef: string | undefined,
): void {
  withRegistryWriteLockSync(() => {
    const registry = loadRegistryStrict();
    const index = registry.providers.findIndex(provider => provider.id === providerId);
    if (!authRef) {
      if (index >= 0) {
        registry.providers[index] = { ...registry.providers[index]!, enabled: false };
        saveRegistry(registry);
      }
      return;
    }
    const existing = index >= 0 ? registry.providers[index] : undefined;
    if (existing) {
      registry.providers[index] = {
        ...existing,
        enabled: true,
        authRef,
        authType: 'oauth',
      };
    } else {
      const templateId = registryTemplateId(providerId);
      const template = getTemplateById(templateId);
      if (!template) throw new Error(`OAuth provider template is unavailable: ${providerId}`);
      registry.providers.push({
        id: providerId,
        templateId,
        name: providerDisplayName(providerId),
        enabled: true,
        authRef,
        authType: 'oauth',
        api: {
          npm: template.npm,
          url: template.defaultBaseUrl ?? '',
          ...(template.headers ? { headers: template.headers } : {}),
        },
        addedAt: new Date().toISOString(),
      });
    }
    saveRegistry(registry);
  });
}

export class DaemonAccountService implements DaemonAccountController {
  readonly store: DaemonAccountStore;
  private readonly openAiUsage = new Map<string, UsageState<OpenAiUsageSnapshot>>();
  private readonly xaiUsage = new Map<string, UsageState<XaiUsageSnapshot>>();
  private readonly ticketKey: Buffer;
  private readonly dependencies: DaemonAccountServiceDependencies;

  constructor(
    store = new DaemonAccountStore(),
    dependencies: Partial<DaemonAccountServiceDependencies> = {},
  ) {
    this.store = store;
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.ticketKey = loadOrCreateTicketKey();
    migrateLegacyOAuthAccounts(store);
  }

  async list(): Promise<DaemonAccountView[]> {
    const state = this.store.load();
    const accounts = MANAGED_PROVIDER_IDS.flatMap(providerId => (
      state.accounts.filter(account => account.providerId === providerId)
    ));
    return Promise.all(accounts.map(async account => {
      if (account.providerId === 'openai-oauth') {
        await this.enrichOpenAiIdentity(account);
        const current = this.store.list().find(item => item.id === account.id) ?? account;
        const usage = this.openAiUsage.get(account.id);
        return {
          id: current.id,
          providerId: current.providerId,
          name: providerDisplayName(current.providerId),
          email: current.email,
          selected: current.id === state.selectedAccountIds[current.providerId],
          plan: usage?.snapshot?.plan,
          usage: usage?.snapshot || usage?.error
            ? {
                primaryUsedPercent: usage.snapshot?.primary?.usedPercent,
                primaryResetAt: usage.snapshot?.primary?.resetAt,
                weeklyUsedPercent: usage.snapshot?.weekly?.usedPercent,
                weeklyResetAt: usage.snapshot?.weekly?.resetAt,
                credits: usage.snapshot?.credits,
                additional: usage.snapshot?.additional,
                stale: !usage.fetchedAt
                  || this.dependencies.now() - usage.fetchedAt > USAGE_REFRESH_MS * 2,
                error: usage.error,
                fetchedAt: usage.snapshot?.fetchedAt,
              }
            : undefined,
        };
      }

      const usage = this.xaiUsage.get(account.id);
      return {
        id: account.id,
        providerId: account.providerId,
        name: providerDisplayName(account.providerId),
        email: account.email,
        selected: account.id === state.selectedAccountIds[account.providerId],
        plan: usage?.snapshot?.plan,
        usage: usage?.snapshot || usage?.error
          ? {
              limitUsedPercent: usage.snapshot?.usedPercent,
              limitResetAt: usage.snapshot?.resetAt,
              limitPeriod: usage.snapshot?.period,
              usedCents: usage.snapshot?.usedCents,
              limitCents: usage.snapshot?.limitCents,
              onDemandUsedCents: usage.snapshot?.onDemandUsedCents,
              onDemandLimitCents: usage.snapshot?.onDemandLimitCents,
              prepaidBalanceCents: usage.snapshot?.prepaidBalanceCents,
              stale: !usage.fetchedAt
                || this.dependencies.now() - usage.fetchedAt > USAGE_REFRESH_MS * 2,
              error: usage.error,
              fetchedAt: usage.snapshot?.fetchedAt,
            }
          : undefined,
      };
    }));
  }

  select(id: string): void {
    const account = this.store.select(id);
    syncManagedProviderCredential(account.providerId, account.authRef);
  }

  createLaunchTicket(accountId?: string): LaunchTicket | null {
    const selected = Object.fromEntries(MANAGED_PROVIDER_IDS.flatMap(providerId => {
      const account = this.store.selected(providerId);
      return account ? [[providerId, account.id]] : [];
    })) as LaunchTicket['accountIds'];
    if (accountId) {
      const account = findAccount(this.store, accountId);
      if (!account) throw new Error(`Managed account not found: ${accountId}`);
      selected[account.providerId] = account.id;
    }
    if (Object.keys(selected).length === 0) return null;
    const payload = Buffer.from(JSON.stringify({
      v: 2,
      a: selected,
      i: this.dependencies.now(),
      n: randomBytes(12).toString('base64url'),
    })).toString('base64url');
    const signature = createHmac('sha256', this.ticketKey).update(payload).digest('base64url');
    const labels = Object.values(selected).flatMap(id => {
      const account = this.store.list().find(item => item.id === id);
      return account ? [accountIdentity(account)] : [];
    });
    return {
      ticket: `${payload}.${signature}`,
      accountIds: selected,
      accountLabel: labels.join(', '),
    };
  }

  accountForTicket(
    ticket: string | undefined,
    providerId: ManagedOAuthProviderId = 'openai-oauth',
  ): DaemonAccountRecord | null {
    if (!ticket) return null;
    const [payload, signature, extra] = ticket.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = createHmac('sha256', this.ticketKey).update(payload).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        v?: unknown;
        a?: unknown;
        i?: unknown;
      };
      if (
        parsed.v !== 2
        || !parsed.a
        || typeof parsed.a !== 'object'
        || typeof parsed.i !== 'number'
        || !Number.isFinite(parsed.i)
        || parsed.i > this.dependencies.now() + 60_000
        || this.dependencies.now() - parsed.i > LAUNCH_TICKET_TTL_MS
      ) return null;
      const id = (parsed.a as Record<string, unknown>)[providerId];
      return typeof id === 'string'
        ? this.store.list(providerId).find(account => account.id === id) ?? null
        : null;
    } catch {
      return null;
    }
  }

  async routeForTicket(route: ProxyRoute, ticket: string | undefined): Promise<ProxyRoute> {
    if (
      route.authType !== 'oauth'
      || (route.providerId !== 'openai-oauth' && route.providerId !== 'xai-oauth')
    ) return route;
    const providerId = route.providerId;
    const managedAccounts = this.store.list(providerId);
    if (managedAccounts.length === 0) return route;
    const account = this.accountForTicket(ticket, providerId);
    if (!account) throw new Error(`The ${providerDisplayName(providerId)} launch ticket is missing or expired`);
    const apiKey = await this.dependencies.resolveCredential(providerId, account.authRef);
    if (!apiKey) throw new Error(`OAuth credential is unavailable for ${accountIdentity(account)}`);
    const common = {
      ...route,
      apiKey,
      metricsAccountId: account.id,
      refreshToken: (rejectedAccessToken?: string) => this.dependencies.resolveCredential(
        providerId,
        account.authRef,
        undefined,
        rejectedAccessToken ? { rejectedAccessToken } : {},
      ),
    };
    if (providerId === 'xai-oauth') return common;
    const oauthAccountId = account.accountId
      ?? await this.dependencies.resolveAccountId(account.authRef)
      ?? extractOpenAiAccountId({ access_token: apiKey });
    return { ...common, oauthAccountId };
  }

  async refreshUsage(): Promise<void> {
    await Promise.all(this.store.list().map(account => this.refreshAccountUsage(account)));
  }

  private async enrichOpenAiIdentity(account: DaemonAccountRecord): Promise<void> {
    if (account.email && account.accountId) return;
    try {
      const token = await this.dependencies.resolveCredential(account.providerId, account.authRef);
      if (!token) return;
      const email = account.email
        ?? extractOpenAiEmail({ access_token: token })
        ?? await this.dependencies.fetchEmail(token);
      const accountId = account.accountId
        ?? extractOpenAiAccountId({ access_token: token });
      if ((email && email !== account.email) || (accountId && accountId !== account.accountId)) {
        this.store.updateIdentity(account.id, { email, accountId });
      }
    } catch {
      // Identity enrichment must not hide the account row.
    }
  }

  private async refreshAccountUsage(account: DaemonAccountRecord): Promise<void> {
    if (account.providerId === 'xai-oauth') {
      const existing = this.xaiUsage.get(account.id);
      if (existing?.fetchedAt && this.dependencies.now() - existing.fetchedAt < USAGE_REFRESH_MS) return;
      try {
        const token = await this.dependencies.resolveCredential(account.providerId, account.authRef);
        if (!token) throw new Error('credential unavailable');
        const snapshot = await this.dependencies.fetchXaiUsage(token);
        if (snapshot.email || snapshot.accountId) {
          this.store.updateIdentity(account.id, {
            email: snapshot.email,
            accountId: snapshot.accountId,
          });
        }
        this.xaiUsage.set(account.id, { snapshot, fetchedAt: this.dependencies.now() });
      } catch (error) {
        this.xaiUsage.set(account.id, {
          snapshot: existing?.snapshot,
          fetchedAt: existing?.fetchedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const existing = this.openAiUsage.get(account.id);
    if (existing?.fetchedAt && this.dependencies.now() - existing.fetchedAt < USAGE_REFRESH_MS) return;
    try {
      const token = await this.dependencies.resolveCredential(account.providerId, account.authRef);
      if (!token) throw new Error('credential unavailable');
      const accountId = account.accountId
        ?? await this.dependencies.resolveAccountId(account.authRef)
        ?? extractOpenAiAccountId({ access_token: token });
      const snapshot = await this.dependencies.fetchUsage(token, accountId);
      this.openAiUsage.set(account.id, { snapshot, fetchedAt: this.dependencies.now() });
    } catch (error) {
      this.openAiUsage.set(account.id, {
        snapshot: existing?.snapshot,
        fetchedAt: existing?.fetchedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function loadOrCreateTicketKey(path = getDaemonTicketKeyPath()): Buffer {
  try {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url');
    if (key.length === 32) return key;
  } catch {
    // Create below.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    writeFileSync(path, `${key.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return key;
  } catch {
    const existing = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url');
    if (existing.length !== 32) throw new Error('Clodex launch ticket key is invalid');
    return existing;
  }
}

function findAccount(store: DaemonAccountStore, idOrLabel: string): DaemonAccountRecord | null {
  const lookup = idOrLabel.toLowerCase();
  const matches = store.list().filter(account => (
    account.id === idOrLabel
    || account.email?.toLowerCase() === lookup
    || account.label.toLowerCase() === lookup
  ));
  if (matches.length > 1) throw new Error(`Managed account is ambiguous: ${idOrLabel}`);
  return matches[0] ?? null;
}

export function migrateLegacyOAuthAccounts(
  store = new DaemonAccountStore(),
): DaemonAccountRecord[] {
  const migrated: DaemonAccountRecord[] = [];
  const registry = loadRegistry();
  for (const providerId of MANAGED_PROVIDER_IDS) {
    if (store.list(providerId).length > 0) continue;
    const provider = registry.providers.find(item => (
      item.id === providerId && item.authType === 'oauth' && item.enabled
    ));
    if (!provider?.authRef) continue;
    migrated.push(store.add({
      providerId,
      label: 'Default',
      authRef: provider.authRef,
    }));
  }
  return migrated;
}

let singleton: DaemonAccountService | undefined;

export function createDaemonAccountController(): DaemonAccountService {
  singleton ??= new DaemonAccountService();
  return singleton;
}
