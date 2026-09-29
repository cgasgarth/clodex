// All subscription sign-ins use the managed account writer.
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { link } from 'ansi-escapes';
import { loginProviderAccount } from '../daemon/account-command.js';
import { DaemonAccountStore } from '../daemon/account-store.js';
import { readProviderOAuthCredential } from '../config/environment.js';
import { supportsNativeOAuth, type StoredOAuthCredential } from '../oauth/types.js';
import { loadRegistryStrict } from './io.js';
import type { RegistryProvider } from './types.js';

export type ProviderAuthMethod = 'native';
export interface ProviderAuthOptions { method?: ProviderAuthMethod }
export interface ProviderAuthResult {
  providerId: string;
  credential: StoredOAuthCredential;
  registryProvider: RegistryProvider;
  credentialCleanupPending: boolean;
}

export async function authenticateProvider(
  providerId: string,
  _options: ProviderAuthOptions = {},
): Promise<ProviderAuthResult> {
  if (!supportsNativeOAuth(providerId)) {
    throw new Error('OAuth sign-in is available for openai (ChatGPT) and xai (SuperGrok).');
  }
  const registryId = providerId === 'openai' || providerId === 'openai-oauth' ? 'openai-oauth' : 'xai-oauth';
  const store = new DaemonAccountStore();
  const selected = store.selected(registryId);
  const spinner = p.spinner({ indicator: 'timer' });
  spinner.start('Starting subscription sign-in...');
  try {
    const signedIn = await loginProviderAccount(registryId, {
      ...(selected && { reauthenticate: selected.id }),
      onDeviceCode: ({ url, userCode }) => {
        spinner.stop('');
        p.log.info(pc.cyan(link(userCode ? 'Open subscription sign-in' : 'Continue with ChatGPT', url)));
        if (userCode) p.log.info(`Enter code: ${pc.bold(userCode)}`);
        spinner.start('Waiting for authorization and credential save...');
      },
    });
    const account = store.list(registryId).find(item => item.id === signedIn.id);
    if (!account) throw new Error('The subscription account was not saved');
    const credential = await readProviderOAuthCredential(account.authRef);
    const registryProvider = loadRegistryStrict().providers.find(item => item.id === registryId);
    if (!credential || !registryProvider) throw new Error('The subscription credential was not saved');
    spinner.stop(pc.green(`Authorization saved for ${signedIn.email}`));
    return { providerId: registryId, credential, registryProvider, credentialCleanupPending: false };
  } catch (error) {
    spinner.stop('Sign-in was not saved');
    throw error;
  }
}

export function providerAuthHelpText(): string {
  return `${pc.bold('clodex providers auth')} — sign in with OAuth

${pc.bold('Usage:')}
  clodex providers auth openai
  clodex providers auth xai

${pc.bold('Sign-in methods:')}
  openai   Continue with ChatGPT in your browser (local loopback callback)
  xai      SuperGrok (device code at auth.x.ai)`;
}
