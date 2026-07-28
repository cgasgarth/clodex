import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DaemonAccountStore,
  MAX_DAEMON_ACCOUNTS,
} from '../src/daemon/account-store.js';

let root: string;
let store: DaemonAccountStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clodex-accounts-'));
  store = new DaemonAccountStore(
    { CLODEX_HOME: root },
    join(root, 'accounts.json'),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('DaemonAccountStore', () => {
  it('stores metadata only with owner-only permissions', () => {
    const account = store.add({
      label: ' Work ',
      accountId: 'acct-1',
      authRef: 'keyring:oauth:provider:openai-oauth:account:1',
    });
    const raw = readFileSync(store.path, 'utf8');
    expect(raw).toContain('"label": "Work"');
    expect(raw).not.toContain('access_token');
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(store.selected()?.id).toBe(account.id);
  });

  it('changes only the default selection and retains all accounts', () => {
    const first = store.add({ label: 'One', authRef: 'keyring:one' });
    const second = store.add({ label: 'Two', authRef: 'keyring:two' });
    store.select('Two');
    expect(store.selected()?.id).toBe(second.id);
    expect(store.list().map(account => account.id)).toEqual([first.id, second.id]);
  });

  it('replaces legacy labels with OAuth email identity', () => {
    const account = store.add({ label: 'Default', authRef: 'keyring:one' });
    store.updateIdentity(account.id, {
      email: 'Person@Example.com',
      accountId: 'acct-1',
    });
    expect(store.selected()).toMatchObject({
      label: 'person@example.com',
      email: 'person@example.com',
      accountId: 'acct-1',
    });
    expect(store.select('person@example.com').id).toBe(account.id);
    expect(store.remove('person@example.com').id).toBe(account.id);
  });

  it('enforces unique labels and the five-account cap', () => {
    store.add({ label: 'One', authRef: 'keyring:one' });
    expect(() => store.add({ label: 'one', authRef: 'keyring:duplicate' }))
      .toThrow(/already exists/);
    for (let index = 2; index <= MAX_DAEMON_ACCOUNTS; index += 1) {
      store.add({ label: `Account ${index}`, authRef: `keyring:${index}` });
    }
    expect(() => store.add({ label: 'Overflow', authRef: 'keyring:overflow' }))
      .toThrow(/at most 5/);
  });
});
