import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { getAppHome } from './paths.js';

export const CREDENTIAL_HELPER_ENV = 'CLODEX_CREDENTIAL_HELPER';
export const CREDENTIAL_HELPER_TIMEOUT_ENV = 'CLODEX_CREDENTIAL_HELPER_TIMEOUT_MS';
export const CREDENTIAL_HELPER_SERVICE = 'clodex';

const CREDENTIAL_ACCOUNT_INSTANCE_SEPARATOR = '::credential::';
const CREDENTIAL_ACCOUNT_INSTANCE_PATTERN = /^v1:[0-9a-f]{32}$/;

const HELPER_TIMEOUT_MS = 10_000;
const HELPER_MAX_OUTPUT_BYTES = 1024 * 1024;

type HelperOperation = 'get' | 'set' | 'delete';

function credentialHelperTimeoutMs(): number {
  const configured = Number(process.env[CREDENTIAL_HELPER_TIMEOUT_ENV]);
  return Number.isFinite(configured) && configured >= 1 && configured <= 60_000
    ? configured
    : HELPER_TIMEOUT_MS;
}

interface HelperResult {
  code: number;
  stdout: string;
}

export interface ConfiguredCredentialHelper {
  path: string;
  id: string;
}

export function credentialHelperIdForPath(path: string): string {
  return createHash('sha256')
    .update('clodex-credential-helper\0')
    .update(normalize(path))
    .digest('hex');
}

export function configuredCredentialHelperPath(): string | null {
  const value = process.env[CREDENTIAL_HELPER_ENV]?.trim();
  if (!value) return null;
  if (!isAbsolute(value)) {
    throw new Error(`${CREDENTIAL_HELPER_ENV} must be an absolute executable path`);
  }
  try {
    const stat = statSync(value);
    if (!stat.isFile()) {
      throw new Error(`${CREDENTIAL_HELPER_ENV} must point to a file`);
    }
    accessSync(value, constants.X_OK);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(CREDENTIAL_HELPER_ENV)) throw err;
    throw new Error(`${CREDENTIAL_HELPER_ENV} is not an executable file`);
  }
  return value;
}

export function configuredCredentialHelper(): ConfiguredCredentialHelper | null {
  const path = configuredCredentialHelperPath();
  return path ? { path, id: credentialHelperIdForPath(path) } : null;
}

export function credentialAuthRef(account: string): string {
  const helper = configuredCredentialHelper();
  return helper
    ? `helper:v1:${helper.id}:${account}`
    : `keyring:${account}`;
}

export function credentialInstanceAuthRef(account: string): string {
  const configScope = createHash('sha256')
    .update('clodex-credential-account\0')
    .update(normalize(resolve(getAppHome())))
    .digest('hex')
    .slice(0, 32);
  return credentialAuthRef(
    `${account}${CREDENTIAL_ACCOUNT_INSTANCE_SEPARATOR}v1:${configScope}`,
  );
}

export function isCredentialAccountInstance(account: string): boolean {
  const separatorIndex = account.lastIndexOf(CREDENTIAL_ACCOUNT_INSTANCE_SEPARATOR);
  if (separatorIndex <= 0) return false;
  return CREDENTIAL_ACCOUNT_INSTANCE_PATTERN.test(
    account.slice(separatorIndex + CREDENTIAL_ACCOUNT_INSTANCE_SEPARATOR.length),
  );
}

export function credentialAccountBase(account: string): string {
  if (!isCredentialAccountInstance(account)) return account;
  return account.slice(0, account.lastIndexOf(CREDENTIAL_ACCOUNT_INSTANCE_SEPARATOR));
}

async function runCredentialHelper(
  operation: HelperOperation,
  account: string,
  input?: string,
  expectedHelperId?: string,
): Promise<HelperResult> {
  const helper = configuredCredentialHelper();
  if (!helper) {
    throw new Error(`${CREDENTIAL_HELPER_ENV} is required for helper credentials`);
  }
  if (expectedHelperId && helper.id !== expectedHelperId) {
    throw new Error(
      `${CREDENTIAL_HELPER_ENV} does not match the helper that owns this credential; restore the prior helper or reauthenticate`,
    );
  }

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: [helper.path, operation, CREDENTIAL_HELPER_SERVICE, account],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    });
  } catch {
    throw new Error(`credential helper ${operation} could not start`);
  }

  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || typeof stdin === 'number' || !stdout || typeof stdout === 'number') {
    child.kill(9);
    throw new Error(`credential helper ${operation} could not start`);
  }
  if (input !== undefined) stdin.write(input);
  stdin.end();

  const readOutput = async (): Promise<string> => {
    const reader = stdout.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > HELPER_MAX_OUTPUT_BYTES) {
          child.kill(9);
          throw new Error(`credential helper ${operation} returned too much output`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output);
  };

  const completion = Promise.all([child.exited, readOutput()]);
  // Bun can leave a killed process's stdout reader pending even after the
  // process exits. Race the operation itself, not just child.exited, so a
  // wedged helper cannot retain the caller.
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill(9);
      reject(new Error(`credential helper ${operation} timed out`));
    }, credentialHelperTimeoutMs());
  });

  try {
    const [code, stdout] = await Promise.race([completion, timeout]);
    return { code, stdout };
  } finally {
    clearTimeout(timer!);
    if (child.exitCode === null) child.kill(9);
    void completion.catch(() => {});
  }
}

export async function readCredentialHelperAccount(account: string, helperId?: string): Promise<string | null> {
  const result = await runCredentialHelper('get', account, undefined, helperId);
  if (result.code === 2) return null;
  if (result.code !== 0) {
    throw new Error(`credential helper get failed with exit code ${result.code}`);
  }
  return result.stdout;
}

export async function writeCredentialHelperAccount(account: string, value: string, helperId?: string): Promise<void> {
  const result = await runCredentialHelper('set', account, value, helperId);
  if (result.code !== 0) {
    throw new Error(`credential helper set failed with exit code ${result.code}`);
  }
}

export async function deleteCredentialHelperAccount(account: string, helperId?: string): Promise<void> {
  const result = await runCredentialHelper('delete', account, undefined, helperId);
  if (result.code !== 0 && result.code !== 2) {
    throw new Error(`credential helper delete failed with exit code ${result.code}`);
  }
}
