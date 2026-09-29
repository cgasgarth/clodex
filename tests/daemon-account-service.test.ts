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
  it('routes an existing launch through the newly selected account', async () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const one = store.add({ label: 'One', authRef: 'keyring:one' });
    const two = store.add({ label: 'Two', authRef: 'keyring:two' });
    const service = new DaemonAccountService(store, {
      resolveProviderData: async authRef => ({clientId: authRef, subject: 'fixture', idToken: 'fixture', scope: 'chatgpt.tokens.use.direct'}),
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

    // SAFETY: The test fixture defines the asserted runtime shape.
    const payload = JSON.parse(
      Buffer.from(launch.ticket.split('.')[0]!, 'base64url').toString('utf8'),
    ) as { a: Record<string, never>; v: number };
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
    expect(service.accountForTicket(undefined)?.id).toBe(two.id);
  });

  it('routes an owner-authenticated plain Claude request through the selected account', async () => {
    const store = new DaemonAccountStore(
      { CLODEX_HOME: root },
      join(root, 'accounts.json'),
    );
    const account = store.add({ label: 'Plain Claude', authRef: 'keyring:plain' });
    const service = new DaemonAccountService(store, {
      resolveProviderData: async authRef => ({clientId: authRef, subject: 'fixture', idToken: 'fixture', scope: 'chatgpt.tokens.use.direct'}),
      resolveCredential: async (_providerId, authRef) => `${authRef}-token`,
    });
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

    await expect(service.routeForTicket(route, undefined))
      .resolves.toEqual(expect.objectContaining({
        apiKey: 'keyring:plain-token',
        metricsAccountId: account.id,
      }));
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
      resolveProviderData: async authRef => ({clientId: authRef, subject: 'fixture', idToken: 'fixture', scope: 'chatgpt.tokens.use.direct'}),
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

    // SAFETY: The test fixture defines the asserted runtime shape.
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
      resolveProviderData: async authRef => ({clientId: authRef, subject: 'fixture', idToken: 'fixture', scope: 'chatgpt.tokens.use.direct'}),
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
    const service = new DaemonAccountService(store, {
      resolveProviderData: async authRef => ({clientId: authRef, subject: 'fixture', idToken: 'fixture', scope: 'chatgpt.tokens.use.direct'}),
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
    const apiRoute = {
      ...openAiRoute,
      aliasId: 'api-astra',
      realModelId: 'gpt-6-astra',
      providerId: 'openai', authType: 'api' as const,
    };

    expect(launch.processingMode).toBe('fast');
    await expect(service.routeForTicket(openAiRoute, launch.ticket))
      .resolves.toMatchObject({ processingMode: 'fast' });
    await expect(service.routeForTicket(apiRoute, launch.ticket))
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
});
