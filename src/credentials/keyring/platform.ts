/** macOS Keychain permissions are attached to each item, so use one shared item. */
export function usesDarwinCredentialVault(): boolean {
  return process.platform === 'darwin';
}
