export const KEYRING_MAX_CHUNKS = 128;
export const KEYRING_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ParsedAuthRef =
  | { kind: 'keyring'; account: string }
  | { kind: 'helper'; helperId: string; account: string }
  | { kind: 'env'; varName: string }
  | { kind: 'none' };

export interface ResolveCredentialOptions {
  rejectedAccessToken?: string;
}

export function providerKeyringAccount(providerId: string): string {
  return `provider:${providerId}`;
}

export function isReservedKeyringAccount(account: string): boolean {
  const separator = '::chunk::';
  const separatorIndex = account.lastIndexOf(separator);
  if (separatorIndex <= 0) return false;
  const suffix = account.slice(separatorIndex + separator.length);
  const parts = suffix.split('::');
  if (parts.length === 2 && !KEYRING_GENERATION_PATTERN.test(parts[0]!)) {
    return false;
  }
  if (parts.length !== 1 && parts.length !== 2) return false;
  const indexText = parts.at(-1)!;
  if (!/^\d+$/.test(indexText)) return false;
  const index = Number(indexText);
  return (
    Number.isSafeInteger(index)
    && indexText === String(index)
    && index >= 0
    && index < KEYRING_MAX_CHUNKS
  );
}

/** Parse registry credential references. */
export function parseAuthRef(authRef: string): ParsedAuthRef | null {
  if (authRef === 'none:anonymous') return { kind: 'none' };
  if (authRef.startsWith('keyring:')) {
    const account = authRef.slice('keyring:'.length);
    return account && !isReservedKeyringAccount(account)
      ? { kind: 'keyring', account }
      : null;
  }
  if (authRef.startsWith('env:')) {
    const varName = authRef.slice('env:'.length);
    return varName ? { kind: 'env', varName } : null;
  }
  const helper = /^helper:v1:([0-9a-f]{64}):(.+)$/s.exec(authRef);
  if (helper) return { kind: 'helper', helperId: helper[1]!, account: helper[2]! };
  return null;
}

/** Env var name for clodex namespaced per-provider keys. */
export function clodexKeyEnvVar(providerId: string): string {
  return `CLODEX_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
