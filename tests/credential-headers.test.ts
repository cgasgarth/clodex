import { describe, expect, it } from 'bun:test';
import { isCredentialBearingHeader } from '../src/credentials/headers.js';

describe('isCredentialBearingHeader', () => {
  it.each([
    'Authorization',
    'Proxy-Authorization',
    'X-API-Key',
    'Cookie',
    'Set-Cookie',
    'X-Auth-Token',
    'X-Client-Secret',
    'X-Credential-Id',
  ])('identifies %s as credential-bearing', (name) => {
    expect(isCredentialBearingHeader(name)).toBe(true);
  });

  it.each([
    'Accept',
    'Content-Type',
    'User-Agent',
    'X-Plan',
    'X-Request-Id',
  ])('preserves non-credential header %s', (name) => {
    expect(isCredentialBearingHeader(name)).toBe(false);
  });
});
