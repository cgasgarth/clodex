import { isObject, isString } from '../runtime/type-guards.js';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getDaemonAccountsPath } from '../config/paths.js';
import { diagnosticRecord } from '../observability/trace-log.js';
import type { DiagnosticValue } from '../observability/trace-log.js';

export const MAX_DAEMON_ACCOUNTS = 5;
const ACCOUNT_STORE_VERSION = 2;

export type ManagedOAuthProviderId = 'openai-oauth' | 'xai-oauth';

export interface DaemonAccountRecord {
  id: string;
  providerId: ManagedOAuthProviderId;
  label: string;
  email?: string;
  accountId?: string;
  authRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface DaemonAccountState {
  version: number;
  selectedAccountIds: Partial<Record<ManagedOAuthProviderId, string>>;
  accounts: DaemonAccountRecord[];
}

interface HomeEnv {
  [name: string]: string | undefined;
  HOME?: string;
  CLODEX_HOME?: string;
  USERPROFILE?: string;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').slice(0, 80);
}

interface ParsedDaemonAccountState {
  state: DaemonAccountState;
  migrated: boolean;
}

interface UntrustedDaemonAccountState {
  version?: DiagnosticValue;
  accounts?: DiagnosticValue;
  selectedAccountIds?: DiagnosticValue;
  selectedAccountId?: DiagnosticValue;
}

function parseProviderId(value: DiagnosticValue): ManagedOAuthProviderId | null {
  if (!isString(value)) return null;
  if (value === 'openai-oauth') return 'openai-oauth';
  if (value === 'xai-oauth') return 'xai-oauth';
  return null;
}

function parseAccount(
  value: DiagnosticValue,
  fallbackProviderId?: ManagedOAuthProviderId,
): DaemonAccountRecord | null {
  if (!value || !isObject(value)) return null;
  const account = diagnosticRecord(value);
  if (
    !isString(account.id)
    || !account.id
    || !isString(account.label)
    || !normalizeLabel(account.label)
    || !isString(account.authRef)
    || !account.authRef
    || !isString(account.createdAt)
    || !isString(account.updatedAt)
  ) return null;
  const providerId = parseProviderId(account.providerId) ?? fallbackProviderId;
  if (!providerId) return null;
  const parsedAccount: DaemonAccountRecord = {
    id: account.id,
    providerId,
    label: normalizeLabel(account.label),
    authRef: account.authRef,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
  if (isString(account.email) && account.email.trim()) {
    parsedAccount.email = account.email.trim().slice(0, 320);
  }
  if (isString(account.accountId) && account.accountId.trim()) {
    parsedAccount.accountId = account.accountId.trim().slice(0, 200);
  }
  return parsedAccount;
}

function parseState(raw: string): ParsedDaemonAccountState {
  const parsed: UntrustedDaemonAccountState = JSON.parse(raw);
  if ((parsed.version !== 1 && parsed.version !== ACCOUNT_STORE_VERSION) || !Array.isArray(parsed.accounts)) {
    throw new Error('Managed account store has an unsupported version');
  }
  const migrated = parsed.version === 1;
  const accounts = parsed.accounts
    .map(value => parseAccount(value, migrated ? 'openai-oauth' : undefined))
    .filter((item): item is DaemonAccountRecord => Boolean(item));
  if (
    accounts.length !== parsed.accounts.length
    || accounts.some(account => (
      accounts.filter(item => item.providerId === account.providerId).length > MAX_DAEMON_ACCOUNTS
    ))
  ) {
    throw new Error('Managed account store contains invalid accounts');
  }
  const savedSelections = !migrated
    && parsed.selectedAccountIds
    && isObject(parsed.selectedAccountIds)
    && !Array.isArray(parsed.selectedAccountIds)
    ? parsed.selectedAccountIds
    : {};
  const selectedAccountIds: DaemonAccountState['selectedAccountIds'] = {};
  for (const providerId of ['openai-oauth', 'xai-oauth'] as const) {
    const candidate = migrated && providerId === 'openai-oauth'
      ? parsed.selectedAccountId
      : savedSelections[providerId];
    const selected = isString(candidate)
      && accounts.some(account => account.providerId === providerId && account.id === candidate)
      ? candidate
      : accounts.find(account => account.providerId === providerId)?.id;
    if (selected) selectedAccountIds[providerId] = selected;
  }
  return { state: {
    version: ACCOUNT_STORE_VERSION,
    selectedAccountIds,
    accounts,
  }, migrated };
}

export class DaemonAccountStore {
  readonly path: string;

  constructor(env: HomeEnv = process.env, path = getDaemonAccountsPath(env)) {
    this.path = path;
  }

  load(): DaemonAccountState {
    try {
      const parsed = parseState(readFileSync(this.path, 'utf8'));
      if (parsed.migrated) this.save(parsed.state);
      return parsed.state;
    } catch (error) {
      const code = isObject(error) && 'code' in error && isString(error.code)
        ? error.code
        : undefined;
      if (code === 'ENOENT') {
        return { version: ACCOUNT_STORE_VERSION, selectedAccountIds: {}, accounts: [] };
      }
      throw error;
    }
  }

  list(providerId?: ManagedOAuthProviderId): DaemonAccountRecord[] {
    const accounts = this.load().accounts;
    return providerId ? accounts.filter(account => account.providerId === providerId) : accounts;
  }

  selected(providerId: ManagedOAuthProviderId = 'openai-oauth'): DaemonAccountRecord | null {
    const state = this.load();
    return state.accounts.find(account => (
      account.providerId === providerId
      && account.id === state.selectedAccountIds[providerId]
    ))
      ?? state.accounts.find(account => account.providerId === providerId)
      ?? null;
  }

  add(
    account: Omit<DaemonAccountRecord, 'id' | 'createdAt' | 'updatedAt' | 'providerId'> & {
      id?: string;
      providerId?: ManagedOAuthProviderId;
    },
  ): DaemonAccountRecord {
    const state = this.load();
    const providerId = account.providerId ?? 'openai-oauth';
    if (state.accounts.filter(item => item.providerId === providerId).length >= MAX_DAEMON_ACCOUNTS) {
      throw new Error(
        `Clodex supports at most ${MAX_DAEMON_ACCOUNTS} managed ${providerId} accounts`,
      );
    }
    const label = normalizeLabel(account.label);
    if (!label) throw new Error('Account label cannot be empty');
    if (state.accounts.some(item => (
      item.providerId === providerId
      && item.label.toLowerCase() === label.toLowerCase()
    ))) {
      throw new Error(`An account named "${label}" already exists`);
    }
    const now = new Date().toISOString();
    const record: DaemonAccountRecord = {
      id: account.id ?? randomUUID(),
      providerId,
      label,
      authRef: account.authRef,
      createdAt: now,
      updatedAt: now,
    };
    if (account.email) record.email = account.email.trim();
    if (account.accountId) record.accountId = account.accountId.trim();
    state.accounts.push(record);
    state.selectedAccountIds[record.providerId] ??= record.id;
    this.save(state);
    return record;
  }

  select(
    idOrLabel: string,
    providerId?: ManagedOAuthProviderId,
  ): DaemonAccountRecord {
    const state = this.load();
    const lookup = idOrLabel.trim().toLowerCase();
    const matches = state.accounts.filter(item => (
      (!providerId || item.providerId === providerId)
      && (
        item.id === idOrLabel
        || item.label.toLowerCase() === lookup
        || item.email?.toLowerCase() === lookup
      )
    ));
    if (matches.length > 1) throw new Error(`Managed account is ambiguous: ${idOrLabel}`);
    const account = matches[0];
    if (!account) throw new Error(`Managed account not found: ${idOrLabel}`);
    state.selectedAccountIds[account.providerId] = account.id;
    account.updatedAt = new Date().toISOString();
    this.save(state);
    return account;
  }

  remove(
    idOrLabel: string,
    providerId?: ManagedOAuthProviderId,
  ): DaemonAccountRecord {
    const state = this.load();
    const lookup = idOrLabel.trim().toLowerCase();
    const matches = state.accounts
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => (
        (!providerId || item.providerId === providerId)
        && (
          item.id === idOrLabel
          || item.label.toLowerCase() === lookup
          || item.email?.toLowerCase() === lookup
        )
      ));
    if (matches.length > 1) throw new Error(`Managed account is ambiguous: ${idOrLabel}`);
    const index = matches[0]?.index ?? -1;
    if (index < 0) throw new Error(`Managed account not found: ${idOrLabel}`);
    const [removed] = state.accounts.splice(index, 1);
    if (state.selectedAccountIds[removed!.providerId] === removed!.id) {
      const replacement = state.accounts.find(account => account.providerId === removed!.providerId);
      if (replacement) state.selectedAccountIds[removed!.providerId] = replacement.id;
      else delete state.selectedAccountIds[removed!.providerId];
    }
    this.save(state);
    return removed!;
  }

  updateIdentity(
    id: string,
    identity: { email?: string; accountId?: string },
  ): DaemonAccountRecord {
    const state = this.load();
    const account = state.accounts.find(item => item.id === id);
    if (!account) throw new Error(`Managed account not found: ${id}`);
    const email = identity.email?.trim().toLowerCase();
    const accountId = identity.accountId?.trim();
    if (email) {
      account.email = email;
      account.label = email;
    }
    if (accountId) account.accountId = accountId;
    account.updatedAt = new Date().toISOString();
    this.save(state);
    return account;
  }

  private save(state: DaemonAccountState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
