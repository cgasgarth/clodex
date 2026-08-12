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
import { loadRegistry } from '../registry/io.js';
import type { DaemonAccountController, DaemonAccountView } from './control-api.js';
import {
  DaemonAccountStore,
  type DaemonAccountRecord,
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

interface UsageState {
  snapshot?: OpenAiUsageSnapshot;
  fetchedAt?: number;
  error?: string;
}

interface XaiUsageState {
  snapshot?: XaiUsageSnapshot;
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
  accountId: string;
  accountLabel: string;
}

function accountIdentity(account: DaemonAccountRecord): string {
  return account.email ?? 'managed OpenAI account';
}

export class DaemonAccountService implements DaemonAccountController {
  readonly store: DaemonAccountStore;
  private readonly usage = new Map<string, UsageState>();
  private xaiUsage: XaiUsageState = {};
  private readonly ticketKey: Buffer;
  private readonly dependencies: DaemonAccountServiceDependencies;

  constructor(
    store = new DaemonAccountStore(),
    dependencies: Partial<DaemonAccountServiceDependencies> = {},
  ) {
    this.store = store;
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.ticketKey = loadOrCreateTicketKey();
    migrateLegacyOpenAiAccount(store);
  }

  async list(): Promise<DaemonAccountView[]> {
    const state = this.store.load();
    const openAiAccounts = await Promise.all(state.accounts.map(async account => {
      const usage = this.usage.get(account.id);
      let email = account.email;
      let accountId = account.accountId;
      if (!email || !accountId) {
        try {
          const token = await this.dependencies.resolveCredential(
            'openai-oauth',
            account.authRef,
          );
          if (token) {
            email ??= extractOpenAiEmail({ access_token: token });
            email ??= await this.dependencies.fetchEmail(token);
            accountId ??= extractOpenAiAccountId({ access_token: token });
            if (
              (email && email !== account.email)
              || (accountId && accountId !== account.accountId)
            ) {
              this.store.updateIdentity(account.id, { email, accountId });
            }
          }
        } catch {
          // Identity enrichment must not hide the account row.
        }
      }
      return {
        id: account.id,
        providerId: 'openai-oauth' as const,
        managed: true,
        email,
        selected: account.id === state.selectedAccountId,
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
    }));
    const xaiProvider = loadRegistry().providers.find(provider =>
      provider.id === 'xai-oauth' && provider.authType === 'oauth' && provider.enabled,
    );
    if (!xaiProvider) return openAiAccounts;
    const usage = this.xaiUsage;
    return [...openAiAccounts, {
      id: 'provider:xai-oauth',
      providerId: 'xai-oauth',
      name: xaiProvider.name,
      managed: false,
      selected: false,
      plan: usage.snapshot?.plan,
      usage: usage.snapshot || usage.error
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
    }];
  }

  select(id: string): void {
    this.store.select(id);
  }

  createLaunchTicket(accountId?: string): LaunchTicket | null {
    const account = accountId ? findAccount(this.store, accountId) : this.store.selected();
    if (!account) {
      if (accountId) throw new Error(`Managed account not found: ${accountId}`);
      return null;
    }
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      a: account.id,
      i: this.dependencies.now(),
      n: randomBytes(12).toString('base64url'),
    })).toString('base64url');
    const signature = createHmac('sha256', this.ticketKey).update(payload).digest('base64url');
    const ticket = `${payload}.${signature}`;
    return { ticket, accountId: account.id, accountLabel: accountIdentity(account) };
  }

  accountForTicket(ticket: string | undefined): DaemonAccountRecord | null {
    // Once managed accounts exist, every OAuth request must carry a durable
    // launch ticket. Falling back to the mutable default would silently move a
    // running session when the user selects another account.
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
        parsed.v !== 1
        || typeof parsed.a !== 'string'
        || typeof parsed.i !== 'number'
        || !Number.isFinite(parsed.i)
        || parsed.i > this.dependencies.now() + 60_000
        || this.dependencies.now() - parsed.i > LAUNCH_TICKET_TTL_MS
      ) return null;
      return findAccount(this.store, parsed.a);
    } catch {
      return null;
    }
  }

  async routeForTicket(route: ProxyRoute, ticket: string | undefined): Promise<ProxyRoute> {
    if (route.providerId !== 'openai-oauth' || route.authType !== 'oauth') return route;
    const account = this.accountForTicket(ticket);
    if (!account) throw new Error('The Clodex launch ticket is missing or expired');
    const apiKey = await this.dependencies.resolveCredential(
      'openai-oauth',
      account.authRef,
    );
    if (!apiKey) throw new Error(`OAuth credential is unavailable for ${accountIdentity(account)}`);
    const oauthAccountId = account.accountId
      ?? await this.dependencies.resolveAccountId(account.authRef)
      ?? extractOpenAiAccountId({ access_token: apiKey });
    return {
      ...route,
      apiKey,
      oauthAccountId,
      metricsAccountId: account.id,
      refreshToken: rejectedAccessToken => this.dependencies.resolveCredential(
        'openai-oauth',
        account.authRef,
        undefined,
        rejectedAccessToken ? { rejectedAccessToken } : {},
      ),
    };
  }

  async refreshUsage(): Promise<void> {
    const providers = loadRegistry().providers;
    const xaiProvider = providers.find(provider =>
      provider.id === 'xai-oauth' && provider.authType === 'oauth' && provider.enabled,
    );
    await Promise.all([
      ...this.store.list().map(account => this.refreshAccountUsage(account)),
      ...(xaiProvider ? [this.refreshXaiUsage(xaiProvider.authRef)] : []),
    ]);
  }

  private async refreshXaiUsage(authRef: string): Promise<void> {
    if (
      this.xaiUsage.fetchedAt
      && this.dependencies.now() - this.xaiUsage.fetchedAt < USAGE_REFRESH_MS
    ) return;
    const existing = this.xaiUsage;
    try {
      const token = await this.dependencies.resolveCredential('xai-oauth', authRef);
      if (!token) throw new Error('credential unavailable');
      const snapshot = await this.dependencies.fetchXaiUsage(token);
      this.xaiUsage = { snapshot, fetchedAt: this.dependencies.now() };
    } catch (error) {
      this.xaiUsage = {
        snapshot: existing.snapshot,
        fetchedAt: existing.fetchedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async refreshAccountUsage(account: DaemonAccountRecord): Promise<void> {
    const existing = this.usage.get(account.id);
    if (
      existing?.fetchedAt
      && this.dependencies.now() - existing.fetchedAt < USAGE_REFRESH_MS
    ) return;
    try {
      const token = await this.dependencies.resolveCredential(
        'openai-oauth',
        account.authRef,
      );
      if (!token) throw new Error('credential unavailable');
      const accountId = account.accountId
        ?? await this.dependencies.resolveAccountId(account.authRef)
        ?? extractOpenAiAccountId({ access_token: token });
      const snapshot = await this.dependencies.fetchUsage(token, accountId);
      this.usage.set(account.id, {
        snapshot,
        fetchedAt: this.dependencies.now(),
      });
    } catch (error) {
      this.usage.set(account.id, {
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

function findAccount(
  store: DaemonAccountStore,
  idOrLabel: string,
): DaemonAccountRecord | null {
  const lookup = idOrLabel.toLowerCase();
  return store.list().find(account =>
    account.id === idOrLabel
    || account.email?.toLowerCase() === lookup
    || account.label.toLowerCase() === lookup,
  ) ?? null;
}

export function migrateLegacyOpenAiAccount(
  store = new DaemonAccountStore(),
): DaemonAccountRecord | null {
  if (store.list().length > 0) return null;
  const provider = loadRegistry().providers.find(item =>
    item.id === 'openai-oauth' && item.authType === 'oauth',
  );
  if (!provider?.authRef) return null;
  return store.add({
    label: 'Default',
    authRef: provider.authRef,
  });
}

let singleton: DaemonAccountService | undefined;

export function createDaemonAccountController(): DaemonAccountService {
  singleton ??= new DaemonAccountService();
  return singleton;
}
