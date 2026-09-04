import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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

  it('stores the usage-limit auto-switch setting off by default', () => {
    expect(store.load().autoSwitchOnUsageLimit).toBe(false);

    store.setAutoSwitchOnUsageLimit(true);

    expect(new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    ).load().autoSwitchOnUsageLimit).toBe(true);
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

  it('replaces a missing credential reference with refreshed identity', () => {
    const account = store.add({ label: 'Default', authRef: 'keyring:missing' });
    store.replaceCredential(account.id, 'keyring:account-scoped', {
      email: 'Person@Example.com',
      accountId: 'acct-1',
    });
    expect(store.selected()).toMatchObject({
      authRef: 'keyring:account-scoped',
      label: 'person@example.com',
      email: 'person@example.com',
      accountId: 'acct-1',
    });
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

  it('keeps independent selections and account caps for each provider', () => {
    const openAi = store.add({ label: 'OpenAI one', authRef: 'keyring:openai-one' });
    const xaiOne = store.add({
      providerId: 'xai-oauth',
      label: 'xAI one',
      authRef: 'keyring:xai-one',
    });
    const xaiTwo = store.add({
      providerId: 'xai-oauth',
      label: 'xAI two',
      authRef: 'keyring:xai-two',
    });

    store.select(xaiTwo.id);

    expect(store.selected('openai-oauth')?.id).toBe(openAi.id);
    expect(store.selected('xai-oauth')?.id).toBe(xaiTwo.id);
    for (let index = 3; index <= MAX_DAEMON_ACCOUNTS; index += 1) {
      store.add({
        providerId: 'xai-oauth',
        label: `xAI ${index}`,
        authRef: `keyring:xai-${index}`,
      });
    }
    expect(() => store.add({
      providerId: 'xai-oauth',
      label: 'xAI overflow',
      authRef: 'keyring:xai-overflow',
    })).toThrow(/at most 5/);
    expect(store.list('openai-oauth')).toHaveLength(1);
    expect(store.list('xai-oauth')).toHaveLength(5);
    expect(xaiOne.providerId).toBe('xai-oauth');
  });

  it('migrates the OpenAI-only version 1 store', () => {
    writeFileSync(store.path, JSON.stringify({
      version: 1,
      selectedAccountId: 'two',
      accounts: [
        {
          id: 'one',
          label: 'One',
          authRef: 'keyring:one',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
        {
          id: 'two',
          label: 'Two',
          authRef: 'keyring:two',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      ],
    }), { mode: 0o600 });

    expect(store.selected('openai-oauth')).toMatchObject({
      id: 'two',
      providerId: 'openai-oauth',
    });
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toMatchObject({
      version: 2,
      selectedAccountIds: { 'openai-oauth': 'two' },
    });
  });
});
