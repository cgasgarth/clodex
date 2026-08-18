import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import open from 'open';
import { isString } from '../runtime/type-guards.js';
import { credentialInstanceAuthRef } from '../credentials/helper.js';
import {
  deleteProviderCredential,
  provisionProviderCredential,
  resolveProviderCredential,
  resolveProviderOAuthAccountId,
  saveProviderCredential,
} from '../config/environment.js';
import {
  extractOpenAiAccountId,
  extractOpenAiEmail,
  runOpenAiDeviceCodeFlow,
} from '../oauth/openai.js';
import { runXaiDeviceCodeFlow } from '../oauth/xai.js';
import {
  oauthCredentialToKeychainJson,
  tokensToStoredCredential,
} from '../oauth/types.js';
import {
  DaemonAccountStore,
  MAX_DAEMON_ACCOUNTS,
  type ManagedOAuthProviderId,
} from './account-store.js';
import {
  DaemonAccountService,
  migrateLegacyOAuthAccounts,
  providerDisplayName,
  syncManagedProviderCredential,
} from './account-service.js';
import { fetchOpenAiUsage } from './openai-usage.js';
import { fetchOpenAiProfileEmail } from './openai-profile.js';
import { fetchXaiIdentity, fetchXaiUsage } from './xai-usage.js';

export function accountsHelpText(): string {
  return `${pc.bold('clodex accounts')} — manage subscription OAuth accounts

${pc.bold('Usage:')}
  clodex accounts list
  clodex accounts add [openai|xai]
  clodex accounts select <email-or-id>
  clodex accounts remove <email-or-id>
  clodex accounts usage [email-or-id]

Up to ${MAX_DAEMON_ACCOUNTS} accounts per provider can be stored. Selection is
manual and sets that provider's account for the next request from new and
existing default-account launches. Explicit account launches remain pinned.
Clodex never switches accounts automatically after quota, capacity, or
authentication errors.`;
}

function storeWithMigration(): DaemonAccountStore {
  const store = new DaemonAccountStore();
  migrateLegacyOAuthAccounts(store);
  return store;
}

function accountIdentity(account: { email?: string; label?: string }): string {
  return account.email ?? account.label ?? 'Email unavailable';
}

export async function loginProviderAccount(
  providerId: ManagedOAuthProviderId,
  options: {
    onDeviceCode?: (info: { url: string; userCode: string }) => void;
  } = {},
): Promise<{ id: string; email: string; providerId: ManagedOAuthProviderId }> {
  const store = storeWithMigration();
  if (store.list(providerId).length >= MAX_DAEMON_ACCOUNTS) {
    throw new Error(`Clodex supports at most ${MAX_DAEMON_ACCOUNTS} managed ${providerDisplayName(providerId)} accounts`);
  }
  const result = await (providerId === 'openai-oauth'
    ? runOpenAiDeviceCodeFlow
    : runXaiDeviceCodeFlow)(({ url, userCode }) => {
    options.onDeviceCode?.({ url, userCode });
    open(url).catch(() => {});
  });
  const xaiIdentity = providerId === 'xai-oauth'
    ? await fetchXaiIdentity(result.tokens.access_token)
    : undefined;
  const resultEmail = 'email' in result && isString(result.email)
    ? result.email
    : undefined;
  const emailValue = providerId === 'openai-oauth'
    ? resultEmail ?? await fetchOpenAiProfileEmail(result.tokens.access_token)
    : xaiIdentity?.email;
  if (!emailValue) {
    throw new Error(`${providerDisplayName(providerId)} sign-in did not return an account email`);
  }
  const email = emailValue.trim().toLowerCase();
  const resultAccountId = providerId === 'openai-oauth'
    ? result.accountId ?? extractOpenAiAccountId(result.tokens)
    : xaiIdentity?.accountId;
  const existingIdentities = await Promise.all(store.list(providerId).map(async account => {
    const token = await resolveProviderCredential(providerId, account.authRef);
    const storedXaiIdentity = providerId === 'xai-oauth' && token
      ? await fetchXaiIdentity(token).catch(() => undefined)
      : undefined;
    return {
      account,
      email: account.email?.toLowerCase()
        ?? (providerId === 'openai-oauth' && token
          ? extractOpenAiEmail({ access_token: token })
          : storedXaiIdentity?.email),
      accountId: account.accountId
        ?? (providerId === 'openai-oauth' && token
          ? extractOpenAiAccountId({ access_token: token })
          : xaiIdentity?.accountId),
    };
  }));
  const existing = existingIdentities.find(identity =>
    identity.email === email
    || Boolean(resultAccountId && identity.accountId === resultAccountId),
  );

  const credential = tokensToStoredCredential(
    result.tokens,
    undefined,
    resultAccountId,
  );
  if (existing) {
    let diagnostic = '';
    const saved = await saveProviderCredential(
      existing.account.authRef,
      oauthCredentialToKeychainJson(credential),
      message => { diagnostic = message; },
    );
    if (!saved) {
      throw new Error(`Could not update OAuth credential${diagnostic ? `: ${diagnostic}` : ''}`);
    }
    const account = store.updateIdentity(existing.account.id, {
      email,
      accountId: resultAccountId,
    });
    if (store.selected(providerId)?.id === account.id) {
      syncManagedProviderCredential(providerId, account.authRef);
    }
    return { id: account.id, email, providerId };
  }

  const id = randomUUID();
  const authRef = credentialInstanceAuthRef(`oauth:provider:${providerId}:account:${id}`);
  let diagnostic = '';
  const saved = await provisionProviderCredential(
    authRef,
    oauthCredentialToKeychainJson(credential),
    message => { diagnostic = message; },
  );
  if (!saved) {
    throw new Error(`Could not save OAuth credential${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  try {
    const account = store.add({
      id,
      providerId,
      label: email,
      email,
      accountId: resultAccountId,
      authRef,
    });
    if (store.selected(providerId)?.id === account.id) {
      syncManagedProviderCredential(providerId, account.authRef);
    }
    return { id: account.id, email, providerId };
  } catch (error) {
    await deleteProviderCredential(authRef);
    throw error;
  }
}

export async function logoutProviderAccount(idOrEmail: string): Promise<string> {
  const store = storeWithMigration();
  const account = store.remove(idOrEmail);
  const deleted = await deleteProviderCredential(account.authRef);
  syncManagedProviderCredential(
    account.providerId,
    store.selected(account.providerId)?.authRef,
  );
  if (!deleted) {
    throw new Error(`Removed ${accountIdentity(account)}, but credential cleanup could not be verified`);
  }
  return accountIdentity(account);
}

async function printAccounts(store: DaemonAccountStore): Promise<void> {
  const accounts = await new DaemonAccountService(store).list();
  if (accounts.length === 0) {
    console.log('No managed subscription accounts.');
    return;
  }
  for (const account of accounts) {
    const selected = account.selected ? pc.green('●') : pc.dim('○');
    console.log(`  ${selected} ${pc.bold(accountIdentity(account))} ${pc.dim(`${account.providerId} · ${account.id}`)}`);
  }
}

async function printUsage(store: DaemonAccountStore, idOrLabel?: string): Promise<void> {
  const accounts = idOrLabel
    ? [store.list().find(account =>
        account.id === idOrLabel || account.label.toLowerCase() === idOrLabel.toLowerCase(),
      )].filter(Boolean)
    : store.list();
  if (accounts.length === 0) throw new Error(`Managed account not found: ${idOrLabel ?? ''}`);
  for (const account of accounts) {
    if (!account) continue;
    const token = await resolveProviderCredential(account.providerId, account.authRef);
    if (!token) throw new Error(`Credential unavailable for ${accountIdentity(account)}`);
    if (account.providerId === 'xai-oauth') {
      const usage = await fetchXaiUsage(token);
      if (usage.email && usage.email !== account.email) {
        store.updateIdentity(account.id, { email: usage.email, accountId: usage.accountId });
      }
      console.log(pc.bold(usage.email ?? accountIdentity(account)));
      if (usage.plan) console.log(`  plan: ${usage.plan}`);
      if (usage.usedPercent !== undefined) {
        console.log(`  ${usage.period ?? 'usage'}: ${Math.round(100 - usage.usedPercent)}% left${usage.resetAt ? ` · resets ${new Date(usage.resetAt * 1000).toLocaleString()}` : ''}`);
      }
      continue;
    }
    const email = account.email
      ?? extractOpenAiEmail({ access_token: token })
      ?? await fetchOpenAiProfileEmail(token);
    if (email && email !== account.email) {
      store.updateIdentity(account.id, { email });
    }
    const accountId = account.accountId
      ?? await resolveProviderOAuthAccountId(account.authRef);
    const usage = await fetchOpenAiUsage(token, accountId);
    console.log(pc.bold(email ?? 'Email unavailable'));
    if (usage.plan) console.log(`  plan: ${usage.plan}`);
    if (usage.primary) {
      console.log(`  5-hour: ${Math.round(100 - usage.primary.usedPercent)}% left · resets ${new Date(usage.primary.resetAt * 1000).toLocaleString()}`);
    }
    if (usage.weekly) {
      console.log(`  weekly: ${Math.round(100 - usage.weekly.usedPercent)}% left · resets ${new Date(usage.weekly.resetAt * 1000).toLocaleString()}`);
    }
  }
}

export async function runAccountsCommand(args: string[]): Promise<number> {
  const [command = 'list', ...rest] = args.filter(arg => arg !== '--help' && arg !== '-h');
  let value = rest.join(' ').trim();
  const store = storeWithMigration();
  try {
    if (command === 'list') {
      await printAccounts(store);
      return 0;
    }
    if (command === 'add') {
      const providerId = value === 'xai' || value === 'xai-oauth'
        ? 'xai-oauth'
        : value === 'openai' || value === 'openai-oauth' || !value
          ? 'openai-oauth'
          : undefined;
      if (!providerId) throw new Error('Usage: clodex accounts add [openai|xai]');
      const spinner = p.spinner({ indicator: 'timer' });
      spinner.start(`Starting ${providerDisplayName(providerId)} device authorization…`);
      const account = await loginProviderAccount(providerId, {
        onDeviceCode: ({ url, userCode }) => {
          spinner.stop('');
          p.log.info(`Visit: ${pc.cyan(url)}`);
          p.log.info(`Enter code: ${pc.bold(userCode)}`);
          spinner.start('Waiting for authorization…');
        },
      });
      spinner.stop(pc.green(`Signed in as ${account.email}`));
      return 0;
    }
    if (command === 'select') {
      if (!value) throw new Error('Usage: clodex accounts select <email-or-id>');
      const account = store.select(value);
      syncManagedProviderCredential(account.providerId, account.authRef);
      console.log(
        `Selected ${accountIdentity(account)} for ${providerDisplayName(account.providerId)} requests. `
        + 'Existing default-account sessions switch on their next request; explicit account launches remain pinned.',
      );
      return 0;
    }
    if (command === 'remove') {
      if (!value) throw new Error('Usage: clodex accounts remove <email-or-id>');
      const email = await logoutProviderAccount(value);
      console.log(`Signed out ${email}.`);
      return 0;
    }
    if (command === 'usage') {
      await printUsage(store, value || undefined);
      return 0;
    }
    throw new Error(`Unknown accounts command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
