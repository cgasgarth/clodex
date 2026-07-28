import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import open from 'open';
import { credentialInstanceAuthRef } from '../credential-helper.js';
import {
  deleteProviderCredential,
  provisionProviderCredential,
  resolveProviderCredential,
  resolveProviderOAuthAccountId,
} from '../env.js';
import {
  extractOpenAiAccountId,
  extractOpenAiEmail,
  runOpenAiDeviceCodeFlow,
} from '../oauth/openai.js';
import {
  oauthCredentialToKeychainJson,
  tokensToStoredCredential,
} from '../oauth/types.js';
import {
  DaemonAccountStore,
  MAX_DAEMON_ACCOUNTS,
} from './account-store.js';
import {
  DaemonAccountService,
  migrateLegacyOpenAiAccount,
} from './account-service.js';
import { fetchOpenAiUsage } from './openai-usage.js';
import { fetchOpenAiProfileEmail } from './openai-profile.js';

export function accountsHelpText(): string {
  return `${pc.bold('clodex accounts')} — manage OpenAI OAuth accounts

${pc.bold('Usage:')}
  clodex accounts list
  clodex accounts add
  clodex accounts select <email-or-id>
  clodex accounts remove <email-or-id>
  clodex accounts usage [email-or-id]

Up to ${MAX_DAEMON_ACCOUNTS} accounts can be stored. Selection is manual and
sets the default for new Claude launches. Existing launch tickets remain pinned
to their original account. Clodex never switches accounts automatically after
quota, capacity, or authentication errors.`;
}

function storeWithMigration(): DaemonAccountStore {
  const store = new DaemonAccountStore();
  migrateLegacyOpenAiAccount(store);
  return store;
}

function accountIdentity(account: { email?: string }): string {
  return account.email ?? 'Email unavailable';
}

export async function loginOpenAiAccount(options: {
  onDeviceCode?: (info: { url: string; userCode: string }) => void;
} = {}): Promise<{ id: string; email: string }> {
  const store = storeWithMigration();
  if (store.list().length >= MAX_DAEMON_ACCOUNTS) {
    throw new Error(`Clodex supports at most ${MAX_DAEMON_ACCOUNTS} managed accounts`);
  }
  const result = await runOpenAiDeviceCodeFlow(({ url, userCode }) => {
    options.onDeviceCode?.({ url, userCode });
    open(url).catch(() => {});
  });
  const email = result.email
    ?? await fetchOpenAiProfileEmail(result.tokens.access_token);
  if (!email) {
    throw new Error('OpenAI sign-in did not return an account email');
  }
  const resultAccountId = result.accountId ?? extractOpenAiAccountId(result.tokens);
  const existingIdentities = await Promise.all(store.list().map(async account => {
    const token = await resolveProviderCredential('openai-oauth', account.authRef);
    return {
      account,
      email: account.email?.toLowerCase()
        ?? (token ? extractOpenAiEmail({ access_token: token }) : undefined),
      accountId: account.accountId
        ?? (token ? extractOpenAiAccountId({ access_token: token }) : undefined),
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
    const saved = await provisionProviderCredential(
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
    return { id: account.id, email };
  }

  const id = randomUUID();
  const authRef = credentialInstanceAuthRef(`oauth:provider:openai-oauth:account:${id}`);
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
      label: email,
      email,
      accountId: resultAccountId,
      authRef,
    });
    return { id: account.id, email };
  } catch (error) {
    await deleteProviderCredential(authRef);
    throw error;
  }
}

export async function logoutOpenAiAccount(idOrEmail: string): Promise<string> {
  const store = storeWithMigration();
  const account = store.remove(idOrEmail);
  const deleted = await deleteProviderCredential(account.authRef);
  if (!deleted) {
    throw new Error(`Removed ${accountIdentity(account)}, but credential cleanup could not be verified`);
  }
  return accountIdentity(account);
}

async function printAccounts(store: DaemonAccountStore): Promise<void> {
  const accounts = await new DaemonAccountService(store).list();
  if (accounts.length === 0) {
    console.log('No managed OpenAI accounts.');
    return;
  }
  for (const account of accounts) {
    const selected = account.selected ? pc.green('●') : pc.dim('○');
    console.log(`  ${selected} ${pc.bold(accountIdentity(account))} ${pc.dim(account.id)}`);
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
    const token = await resolveProviderCredential('openai-oauth', account.authRef);
    if (!token) throw new Error(`Credential unavailable for ${accountIdentity(account)}`);
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
      const spinner = p.spinner();
      spinner.start('Starting OpenAI device authorization…');
      const account = await loginOpenAiAccount({
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
      console.log(`Selected ${accountIdentity(account)} for new Claude launches. Existing sessions remain pinned.`);
      return 0;
    }
    if (command === 'remove') {
      if (!value) throw new Error('Usage: clodex accounts remove <email-or-id>');
      const email = await logoutOpenAiAccount(value);
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
