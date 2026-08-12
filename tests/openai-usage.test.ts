import { describe, expect, it, vi } from 'bun:test';
import {
  fetchOpenAiUsage,
  parseOpenAiUsage,
} from '../src/daemon/openai-usage.js';

const payload = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: {
      used_percent: 22,
      reset_at: 2_000_000_000,
      limit_window_seconds: 18_000,
    },
    secondary_window: {
      used_percent: 41,
      reset_at: 2_000_100_000,
      limit_window_seconds: 604_800,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: 12.5 },
  additional_rate_limits: [
    {
      limit_name: 'Extra model',
      metered_feature: 'extra_model',
      rate_limit: {
        secondary_window: {
          used_percent: 1,
          reset_at: 2_000_200_000,
          limit_window_seconds: 604_800,
        },
      },
    },
    { malformed: true },
  ],
};

describe('OpenAI usage fetcher', () => {
  it('maps primary, weekly, credits, and valid additional windows', () => {
    const usage = parseOpenAiUsage(payload, new Date('2026-07-28T00:00:00Z'));
    expect(usage.plan).toBe('pro');
    expect(usage.primary?.usedPercent).toBe(22);
    expect(usage.weekly?.limitWindowSeconds).toBe(604_800);
    expect(usage.credits?.balance).toBe(12.5);
    expect(usage.additional[0]?.name).toBe('Extra model');
    expect(usage.additional).toHaveLength(1);
  });

  it('labels a lone seven-day primary window as weekly', () => {
    const usage = parseOpenAiUsage({
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 5,
          reset_at: 2_000_000_000,
          limit_window_seconds: 604_800,
        },
      },
    });
    expect(usage.primary).toBeUndefined();
    expect(usage.weekly?.usedPercent).toBe(5);
  });

  it('sends account-scoped authenticated requests without exposing the token', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(String(url)).toBe('https://chatgpt.com/backend-api/wham/usage');
      expect(headers.get('authorization')).toBe('Bearer secret-token');
      expect(headers.get('chatgpt-account-id')).toBe('acct-1');
      expect(headers.get('user-agent')).toBe('codex-cli');
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const usage = await fetchOpenAiUsage('secret-token', 'acct-1', {
      fetch: request as typeof fetch,
    });
    expect(usage.plan).toBe('pro');
    expect(request).toHaveBeenCalledOnce();
  });
});
