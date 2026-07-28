import { describe, expect, it, vi } from 'vitest';
import { fetchOpenAiProfileEmail } from '../src/daemon/openai-profile.js';

describe('OpenAI profile identity fetcher', () => {
  it('returns a normalized email from the official profile endpoint', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(String(url)).toBe('https://api.openai.com/v1/me');
      expect(headers.get('authorization')).toBe('Bearer secret-token');
      expect(headers.get('user-agent')).toBe('codex-cli');
      return new Response(JSON.stringify({ email: 'Person@Example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(fetchOpenAiProfileEmail('secret-token', {
      fetch: request as typeof fetch,
    })).resolves.toBe('person@example.com');
  });
});
