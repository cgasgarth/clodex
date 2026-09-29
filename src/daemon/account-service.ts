import { isNumber, isObject, isString } from '../runtime/type-guards.js';
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
  resolveProviderOAuthProviderData,
} from '../config/environment.js';
import { openAiRegistrationFromData } from '../oauth/openai.js';
import type { ProxyRoute } from '../proxy/index.js';
import { getDaemonTicketKeyPath } from '../config/paths.js';
import { getTemplateById } from '../providers/templates.js';
import { loadRegistryStrict, saveRegistry } from '../registry/io.js';
import { withRegistryWriteLockSync } from '../registry/lock.js';
import type { RegistryProvider } from '../registry/types.js';
import type {
  DaemonAccountController,
  DaemonAccountView,
} from './control-api.js';
import type { ApiProcessingMode } from './api-pricing.js';
import {
  DaemonAccountStore,
  type DaemonAccountRecord,
  type ManagedOAuthProviderId,
} from './account-store.js';
import { diagnosticRecord } from '../observability/trace-log.js';

export function providerDisplayName(): string { return 'OpenAI (ChatGPT)'; }

const LAUNCH_TICKET_TTL_MS = 30 * 24 * 60 * 60_000;
interface DaemonAccountServiceDependencies {
  resolveCredential: typeof resolveProviderCredential;
  resolveProviderData: typeof resolveProviderOAuthProviderData;
  now: () => number;
}

const defaultDependencies: DaemonAccountServiceDependencies = {
  resolveCredential: resolveProviderCredential,
  resolveProviderData: resolveProviderOAuthProviderData,
  now: Date.now,
};

export interface LaunchTicket {
  ticket: string;
  accountIds: Partial<Record<ManagedOAuthProviderId, string>>;
  accountLabel: string;
  processingMode: ApiProcessingMode;
}

interface LaunchTicketPayload {
  pinnedAccountIds: LaunchTicket['accountIds'];
  processingMode: ApiProcessingMode;
}

interface LaunchTicketWirePayload {
  v: number;
  a: LaunchTicket['accountIds'];
  i: number;
  n: string;
  p?: 'fast';
}

function accountIdentity(account: DaemonAccountRecord): string {
  return account.email ?? account.label;
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
      const templateId = 'openai';
      const template = getTemplateById(templateId);
      if (!template) throw new Error(`OAuth provider template is unavailable: ${providerId}`);
      const api: RegistryProvider['api'] = {
        npm: template.npm,
        url: template.defaultBaseUrl ?? '',
      };
      if (template.headers) api.headers = template.headers;
      registry.providers.push({
        id: providerId,
        templateId,
        name: providerDisplayName(),
        enabled: true,
        authRef,
        authType: 'oauth',
        api,
        addedAt: new Date().toISOString(),
      });
    }
    saveRegistry(registry);
  });
}

export class DaemonAccountService implements DaemonAccountController {
  readonly store: DaemonAccountStore;
  private readonly ticketKey: Buffer;
  private readonly dependencies: DaemonAccountServiceDependencies;

  constructor(
    store = new DaemonAccountStore(),
    dependencies: Partial<DaemonAccountServiceDependencies> = {},
  ) {
    this.store = store;
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.ticketKey = loadOrCreateTicketKey();
  }

  async list(): Promise<DaemonAccountView[]> {
    const state = this.store.load();
    return Promise.all(state.accounts.map(async account => {
      const registration = openAiRegistrationFromData(await this.dependencies.resolveProviderData(account.authRef));
      return {
        id: account.id, providerId: account.providerId, name: providerDisplayName(),
        email: account.email, requiresSignIn: !registration,
        selected: Boolean(registration) && account.id === state.selectedAccountIds[account.providerId],
      };
    }));
  }

  select(id: string): void {
    const account = this.store.select(id);
    syncManagedProviderCredential(account.providerId, account.authRef);
  }

  createLaunchTicket(
    accountId?: string,
    processingMode: ApiProcessingMode = 'standard',
  ): LaunchTicket | null {
    const selected: LaunchTicket['accountIds'] = {};
    for (const providerId of (['openai-oauth'] as const)) {
      const account = this.store.selected();
      if (account) selected[providerId] = account.id;
    }
    const pinned: LaunchTicket['accountIds'] = {};
    if (accountId) {
      const account = findAccount(this.store, accountId);
      if (!account) throw new Error(`Managed account not found: ${accountId}`);
      selected[account.providerId] = account.id;
      pinned[account.providerId] = account.id;
    }
    if (Object.keys(selected).length === 0 && processingMode === 'standard') return null;
    const ticketPayload: LaunchTicketWirePayload = {
      v: 3,
      a: pinned,
      i: this.dependencies.now(),
      n: randomBytes(12).toString('base64url'),
    };
    if (processingMode === 'fast') ticketPayload.p = 'fast';
    const payload = Buffer.from(JSON.stringify(ticketPayload)).toString('base64url');
    const signature = createHmac('sha256', this.ticketKey).update(payload).digest('base64url');
    const labels = Object.values(selected).flatMap(id => {
      const account = this.store.list().find(item => item.id === id);
      return account ? [accountIdentity(account)] : [];
    });
    return {
      ticket: `${payload}.${signature}`,
      accountIds: selected,
      accountLabel: labels.join(', '),
      processingMode,
    };
  }

  private launchForTicket(ticket: string | undefined): LaunchTicketPayload | null {
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
      const parsed: {
        v?: unknown;
        a?: unknown;
        i?: unknown;
        p?: unknown;
      } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (
        parsed.v !== 3
        || !parsed.a
        || !isObject(parsed.a)
        || !isNumber(parsed.i)
        || !Number.isFinite(parsed.i)
        || parsed.i > this.dependencies.now() + 60_000
        || this.dependencies.now() - parsed.i > LAUNCH_TICKET_TTL_MS
        || (parsed.p !== undefined && parsed.p !== 'fast')
      ) return null;
      const pinnedAccountIds: LaunchTicket['accountIds'] = {};
      const parsedAccountIds = diagnosticRecord(parsed.a);
      for (const providerId of (['openai-oauth'] as const)) {
        const accountId = parsedAccountIds[providerId];
        if (isString(accountId)) pinnedAccountIds[providerId] = accountId;
      }
      return {
        pinnedAccountIds,
        processingMode: parsed.p === 'fast' ? 'fast' : 'standard',
      };
    } catch {
      return null;
    }
  }

  accountForTicket(
    ticket: string | undefined,
    providerId: ManagedOAuthProviderId = 'openai-oauth',
  ): DaemonAccountRecord | null {
    if (!ticket) return this.store.selected();
    const launch = this.launchForTicket(ticket);
    if (!launch) return null;
    const id = launch.pinnedAccountIds[providerId]
      ?? this.store.selected()?.id;
    return isString(id)
      ? this.store.list().find(account => account.id === id) ?? null
      : null;
  }

  async routeForTicket(route: ProxyRoute, ticket: string | undefined): Promise<ProxyRoute> {
    if (
      route.authType !== 'oauth'
      || route.providerId !== 'openai-oauth'
    ) return route;
    const providerId = route.providerId;
    const launch = this.launchForTicket(ticket);
    const launchRoute = launch?.processingMode === 'fast'
      ? { ...route, processingMode: 'fast' as const }
      : route;
    const managedAccounts = this.store.list();
    if (managedAccounts.length === 0) return launchRoute;
    const account = this.accountForTicket(ticket, providerId);
    if (!account) {
      throw new Error(
        `The ${providerDisplayName()} launch ticket is invalid or no account is selected`,
      );
    }
    return this.routeForAccount(launchRoute, account);
  }

  private async routeForAccount(
    route: ProxyRoute,
    account: DaemonAccountRecord,
  ): Promise<ProxyRoute> {
    const providerId = account.providerId;
    const apiKey = await this.dependencies.resolveCredential(providerId, account.authRef);
    if (!apiKey) throw new Error(`OAuth credential is unavailable for ${accountIdentity(account)}`);
    const common: ProxyRoute = {
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
    const registration = openAiRegistrationFromData(await this.dependencies.resolveProviderData(account.authRef));
    if (!registration) throw new Error('Sign in to Clodex with ChatGPT before sending requests');
    const oauthAccountId = registration.clientId;
    return { ...common, oauthAccountId };
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

let singleton: DaemonAccountService | undefined;

export function createDaemonAccountController(): DaemonAccountService {
  singleton ??= new DaemonAccountService();
  return singleton;
}
