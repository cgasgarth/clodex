import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DaemonAccountService } from '../src/daemon/account-service.js';
import { DaemonAccountStore } from '../src/daemon/account-store.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';

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
  it('routes an existing launch through the newly selected account', async () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const one = store.add({ label: 'One', authRef: 'keyring:one' });
    const two = store.add({ label: 'Two', authRef: 'keyring:two' });
    const service = new DaemonAccountService(store, {
      resolveCredential: async (_providerId, authRef) => `${authRef}-token`,
    });
    const launch = service.createLaunchTicket()!;
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

    const payload = JSON.parse(
      Buffer.from(launch.ticket.split('.')[0]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ v: 3, a: {} });
    expect(launch.accountIds).toEqual({ 'openai-oauth': one.id });
    expect(service.accountForTicket(launch.ticket)?.id).toBe(one.id);
    await expect(service.routeForTicket(route, launch.ticket))
      .resolves.toEqual(expect.objectContaining({
        apiKey: 'keyring:one-token',
        metricsAccountId: one.id,
      }));

    store.select(two.id);

    expect(one.id).not.toBe(two.id);
    expect(service.accountForTicket(launch.ticket)?.id).toBe(two.id);
    await expect(service.routeForTicket(route, launch.ticket))
      .resolves.toEqual(expect.objectContaining({
        apiKey: 'keyring:two-token',
        metricsAccountId: two.id,
      }));
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

    const payload = JSON.parse(
      Buffer.from(launch!.ticket.split('.')[0]!, 'base64url').toString('utf8'),
    ) as { a?: Record<string, string> };
    expect(payload.a).toEqual({ 'openai-oauth': one.id });
    await expect(service.routeForTicket(route, launch!.ticket))
      .rejects.toThrow('OAuth credential is unavailable for One');
  });

  it('tags resolved routes with the local account for metrics', async () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const account = store.add({ label: 'One', authRef: 'keyring:one' });
    const service = new DaemonAccountService(store, {
      resolveCredential: async () => 'account-token',
    });
    const launch = service.createLaunchTicket(account.id);
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
      .resolves.toEqual(expect.objectContaining({
        apiKey: 'account-token',
        metricsAccountId: account.id,
      }));
  });

  it('signs Fast mode into a launch without changing non-OpenAI routes', async () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const openAi = store.add({ label: 'OpenAI', authRef: 'keyring:openai' });
    store.add({
      providerId: 'xai-oauth',
      label: 'xAI',
      authRef: 'keyring:xai',
    });
    const service = new DaemonAccountService(store, {
      resolveCredential: async (_providerId, authRef) => `${authRef}-token`,
    });
    const launch = service.createLaunchTicket(openAi.id, 'fast')!;
    const openAiRoute = {
      aliasId: 'claude-sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'Sol',
      upstreamUrl: 'https://example.test',
      apiKey: 'boot-token',
      modelFormat: 'openai' as const,
      providerId: 'openai-oauth',
      authType: 'oauth' as const,
    };
    const xaiRoute = {
      ...openAiRoute,
      aliasId: 'claude-grok',
      realModelId: 'grok-4.6',
      providerId: 'xai-oauth',
    };

    expect(launch.processingMode).toBe('fast');
    await expect(service.routeForTicket(openAiRoute, launch.ticket))
      .resolves.toMatchObject({ processingMode: 'fast' });
    await expect(service.routeForTicket(xaiRoute, launch.ticket))
      .resolves.not.toHaveProperty('processingMode');
  });

  it('returns no ticket when no managed OAuth account exists', () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const service = new DaemonAccountService(store);
    expect(service.createLaunchTicket()).toBeNull();
    expect(service.createLaunchTicket(undefined, 'fast')).toMatchObject({
      accountIds: {},
      processingMode: 'fast',
    });
  });

  it('imports SuperGrok as a managed provider account and shows its usage', async () => {
    withRegistryWriteLockSync(() => saveRegistry({
      schemaVersion: 1,
      providers: [{
        id: 'xai-oauth',
        templateId: 'xai-oauth',
        name: 'xAI (SuperGrok)',
        enabled: true,
        authRef: 'keyring:xai',
        authType: 'oauth',
        api: { npm: '@ai-sdk/xai', url: 'https://cli-chat-proxy.grok.com/v1' },
        addedAt: '2026-08-12T00:00:00.000Z',
      }],
    }));
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const service = new DaemonAccountService(store, {
      resolveCredential: async (providerId) => providerId === 'xai-oauth' ? 'xai-token' : null,
      fetchXaiUsage: async () => ({
        fetchedAt: '2026-08-12T00:00:00.000Z',
        plan: 'SuperGrok',
        period: 'weekly',
        usedPercent: 25,
        resetAt: 2_000_000_000,
        usedCents: 500,
        limitCents: 2_000,
      }),
    });

    await service.refreshUsage();
    await expect(service.list()).resolves.toEqual([expect.objectContaining({
      providerId: 'xai-oauth',
      name: 'xAI (SuperGrok)',
      selected: true,
      plan: 'SuperGrok',
      usage: expect.objectContaining({
        limitUsedPercent: 25,
        limitResetAt: 2_000_000_000,
        limitPeriod: 'weekly',
        usedCents: 500,
        limitCents: 2_000,
      }),
    })]);
  });

  it('follows independent OpenAI and SuperGrok selections for one launch', async () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
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
    const service = new DaemonAccountService(store, {
      resolveCredential: async (_providerId, authRef) => `${authRef}-token`,
    });
    const launch = service.createLaunchTicket();

    store.select(xaiTwo.id);

    expect(service.accountForTicket(launch!.ticket, 'openai-oauth')?.id).toBe(openAi.id);
    expect(service.accountForTicket(launch!.ticket, 'xai-oauth')?.id).toBe(xaiTwo.id);
    await expect(service.routeForTicket({
      aliasId: 'claude-grok',
      realModelId: 'grok-4.6',
      displayName: 'Grok 4.6',
      upstreamUrl: 'https://cli-chat-proxy.grok.com/v1',
      apiKey: 'boot-token',
      modelFormat: 'openai' as const,
      providerId: 'xai-oauth',
      authType: 'oauth' as const,
    }, launch!.ticket)).resolves.toEqual(expect.objectContaining({
      apiKey: 'keyring:xai-two-token',
      metricsAccountId: xaiTwo.id,
    }));
    expect(xaiOne.id).not.toBe(xaiTwo.id);
  });

  it('updates only the selected provider bootstrap credential', () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    store.add({ label: 'OpenAI one', authRef: 'keyring:openai-one' });
    store.add({
      providerId: 'xai-oauth',
      label: 'xAI one',
      authRef: 'keyring:xai-one',
    });
    const xaiTwo = store.add({
      providerId: 'xai-oauth',
      label: 'xAI two',
      authRef: 'keyring:xai-two',
    });
    withRegistryWriteLockSync(() => saveRegistry({
      schemaVersion: 1,
      providers: [],
    }));
    const service = new DaemonAccountService(store);

    service.select(xaiTwo.id);

    expect(store.selected('openai-oauth')?.authRef).toBe('keyring:openai-one');
    expect(store.selected('xai-oauth')?.authRef).toBe('keyring:xai-two');
    expect(loadRegistry().providers).toEqual([
      expect.objectContaining({
        id: 'xai-oauth',
        authRef: 'keyring:xai-two',
        enabled: true,
      }),
    ]);
  });

  it('does not re-import a signed-out provider credential', () => {
    withRegistryWriteLockSync(() => saveRegistry({
      schemaVersion: 1,
      providers: [{
        id: 'xai-oauth',
        templateId: 'xai-oauth',
        name: 'xAI (SuperGrok)',
        enabled: false,
        authRef: 'keyring:deleted-xai',
        authType: 'oauth',
        api: { npm: '@ai-sdk/xai', url: 'https://cli-chat-proxy.grok.com/v1' },
        addedAt: '2026-08-12T00:00:00.000Z',
      }],
    }));
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );

    new DaemonAccountService(store);

    expect(store.list('xai-oauth')).toEqual([]);
  });
});
