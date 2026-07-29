import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DaemonAccountService } from '../src/daemon/account-service.js';
import { DaemonAccountStore } from '../src/daemon/account-store.js';

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clodex-account-service-'));
  previousHome = process.env['CLODEX_HOME'];
  process.env['CLODEX_HOME'] = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['CLODEX_HOME'];
  else process.env['CLODEX_HOME'] = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('DaemonAccountService launch tickets', () => {
  it('pins an existing launch while the default changes', () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const one = store.add({ label: 'One', authRef: 'keyring:one' });
    const two = store.add({ label: 'Two', authRef: 'keyring:two' });
    const service = new DaemonAccountService(store);
    const launch = service.createLaunchTicket();
    store.select(two.id);

    expect(service.accountForTicket(launch!.ticket)?.id).toBe(one.id);
    expect(service.accountForTicket(undefined)).toBeNull();
  });

  it('validates durable tickets after a daemon restart and rejects tampering', () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const account = store.add({ label: 'One', authRef: 'keyring:one' });
    const first = new DaemonAccountService(store);
    const launch = first.createLaunchTicket();
    const restarted = new DaemonAccountService(store);

    expect(restarted.accountForTicket(launch!.ticket)?.id).toBe(account.id);
    expect(restarted.accountForTicket(`${launch!.ticket}x`)).toBeNull();
  });

  it('fails the pinned account without falling over to the selected account', async () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const one = store.add({ label: 'One', authRef: 'keyring:one' });
    const two = store.add({ label: 'Two', authRef: 'keyring:two' });
    const service = new DaemonAccountService(store, {
      resolveCredential: async (_providerId, authRef) => (
        authRef === two.authRef ? 'selected-account-token' : null
      ),
    });
    const launch = service.createLaunchTicket(one.id);
    store.select(two.id);
    const route = {
      aliasId: 'claude-sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'Sol',
      upstreamUrl: 'https://example.test',
      apiKey: 'boot-token',
      modelFormat: 'openai' as const,
      providerId: 'openai-oauth',
      authType: 'oauth' as const,
    };

    await expect(service.routeForTicket(route, launch!.ticket))
      .rejects.toThrow('OAuth credential is unavailable for managed OpenAI account');
  });

  it('returns no ticket when no managed OAuth account exists', () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const service = new DaemonAccountService(store);
    expect(service.createLaunchTicket()).toBeNull();
  });
});
