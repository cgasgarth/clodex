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
import { getDaemonAccountsPath } from '../paths.js';

export const MAX_DAEMON_ACCOUNTS = 5;
const ACCOUNT_STORE_VERSION = 1;

export interface DaemonAccountRecord {
  id: string;
  label: string;
  email?: string;
  accountId?: string;
  authRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface DaemonAccountState {
  version: number;
  selectedAccountId?: string;
  accounts: DaemonAccountRecord[];
}

interface HomeEnv {
  HOME?: string;
  CLODEX_HOME?: string;
  USERPROFILE?: string;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function parseAccount(value: unknown): DaemonAccountRecord | null {
  if (!value || typeof value !== 'object') return null;
  const account = value as Partial<DaemonAccountRecord>;
  if (
    typeof account.id !== 'string'
    || !account.id
    || typeof account.label !== 'string'
    || !normalizeLabel(account.label)
    || typeof account.authRef !== 'string'
    || !account.authRef
    || typeof account.createdAt !== 'string'
    || typeof account.updatedAt !== 'string'
  ) return null;
  return {
    id: account.id,
    label: normalizeLabel(account.label),
    ...(typeof account.email === 'string' && account.email.trim()
      ? { email: account.email.trim().slice(0, 320) }
      : {}),
    ...(typeof account.accountId === 'string' && account.accountId.trim()
      ? { accountId: account.accountId.trim().slice(0, 200) }
      : {}),
    authRef: account.authRef,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function parseState(raw: string): DaemonAccountState {
  const parsed = JSON.parse(raw) as Partial<DaemonAccountState>;
  if (parsed.version !== ACCOUNT_STORE_VERSION || !Array.isArray(parsed.accounts)) {
    throw new Error('Managed account store has an unsupported version');
  }
  const accounts = parsed.accounts.map(parseAccount).filter((item): item is DaemonAccountRecord => Boolean(item));
  if (accounts.length !== parsed.accounts.length || accounts.length > MAX_DAEMON_ACCOUNTS) {
    throw new Error('Managed account store contains invalid accounts');
  }
  const selectedAccountId = typeof parsed.selectedAccountId === 'string'
    && accounts.some(account => account.id === parsed.selectedAccountId)
    ? parsed.selectedAccountId
    : accounts[0]?.id;
  return {
    version: ACCOUNT_STORE_VERSION,
    ...(selectedAccountId ? { selectedAccountId } : {}),
    accounts,
  };
}

export class DaemonAccountStore {
  readonly path: string;
  private readonly env: HomeEnv;

  constructor(env: HomeEnv = process.env, path = getDaemonAccountsPath(env)) {
    this.env = env;
    this.path = path;
  }

  load(): DaemonAccountState {
    try {
      return parseState(readFileSync(this.path, 'utf8'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { version: ACCOUNT_STORE_VERSION, accounts: [] };
      throw error;
    }
  }

  list(): DaemonAccountRecord[] {
    return this.load().accounts;
  }

  selected(): DaemonAccountRecord | null {
    const state = this.load();
    return state.accounts.find(account => account.id === state.selectedAccountId)
      ?? state.accounts[0]
      ?? null;
  }

  add(
    account: Omit<DaemonAccountRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): DaemonAccountRecord {
    const state = this.load();
    if (state.accounts.length >= MAX_DAEMON_ACCOUNTS) {
      throw new Error(`Clodex supports at most ${MAX_DAEMON_ACCOUNTS} managed accounts`);
    }
    const label = normalizeLabel(account.label);
    if (!label) throw new Error('Account label cannot be empty');
    if (state.accounts.some(item => item.label.toLowerCase() === label.toLowerCase())) {
      throw new Error(`An account named "${label}" already exists`);
    }
    const now = new Date().toISOString();
    const record: DaemonAccountRecord = {
      id: account.id ?? randomUUID(),
      label,
      ...(account.email ? { email: account.email.trim() } : {}),
      ...(account.accountId ? { accountId: account.accountId.trim() } : {}),
      authRef: account.authRef,
      createdAt: now,
      updatedAt: now,
    };
    state.accounts.push(record);
    state.selectedAccountId ??= record.id;
    this.save(state);
    return record;
  }

  select(idOrLabel: string): DaemonAccountRecord {
    const state = this.load();
    const lookup = idOrLabel.trim().toLowerCase();
    const account = state.accounts.find(item =>
      item.id === idOrLabel
      || item.label.toLowerCase() === lookup
      || item.email?.toLowerCase() === lookup,
    );
    if (!account) throw new Error(`Managed account not found: ${idOrLabel}`);
    state.selectedAccountId = account.id;
    account.updatedAt = new Date().toISOString();
    this.save(state);
    return account;
  }

  remove(idOrLabel: string): DaemonAccountRecord {
    const state = this.load();
    const lookup = idOrLabel.trim().toLowerCase();
    const index = state.accounts.findIndex(item =>
      item.id === idOrLabel
      || item.label.toLowerCase() === lookup
      || item.email?.toLowerCase() === lookup,
    );
    if (index < 0) throw new Error(`Managed account not found: ${idOrLabel}`);
    const [removed] = state.accounts.splice(index, 1);
    if (state.selectedAccountId === removed!.id) {
      state.selectedAccountId = state.accounts[0]?.id;
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
