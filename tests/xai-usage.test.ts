import { describe, expect, it, vi } from 'bun:test';
import { fetchXaiUsage, parseXaiUsage } from '../src/daemon/xai-usage.js';

const payload = {
  subscriptionTier: 'SuperGrok',
  config: {
    creditUsagePercent: 37.5,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-01T00:00:00Z' },
    used: { val: 750 },
    monthlyLimit: { val: 2_000 },
    onDemandUsed: { val: 125 },
    onDemandCap: { val: 1_000 },
    prepaidBalance: { val: 500 },
  },
};

describe('xAI subscription usage', () => {
  it('parses limits, reset time, and credit balances', () => {
    expect(parseXaiUsage(
      payload,
      { subscription_tier_display: 'SuperGrok Heavy' },
      new Date('2026-08-12T00:00:00Z'),
    )).toEqual({
      fetchedAt: '2026-08-12T00:00:00.000Z',
      plan: 'SuperGrok',
      period: 'weekly',
      usedPercent: 37.5,
      resetAt: Date.parse('2026-09-01T00:00:00Z') / 1_000,
      usedCents: 750,
      limitCents: 2_000,
      onDemandUsedCents: 125,
      onDemandLimitCents: 1_000,
      prepaidBalanceCents: 500,
    });
  });

  it('treats omitted proto3 zero values as zero usage and reads the settings tier', () => {
    expect(parseXaiUsage({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          end: '2026-08-15T00:00:00Z',
        },
        onDemandCap: {},
        prepaidBalance: { val: -500 },
      },
    }, { subscription_tier_display: 'Free' }, new Date('2026-08-12T00:00:00Z'))).toEqual({
      fetchedAt: '2026-08-12T00:00:00.000Z',
      plan: 'Free',
      period: 'weekly',
      usedPercent: 0,
      resetAt: Date.parse('2026-08-15T00:00:00Z') / 1_000,
      onDemandLimitCents: 0,
      prepaidBalanceCents: 500,
    });
  });

  it('fetches identity before billing and keeps the token in headers', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userId: 'user-123',
        email: 'person@example.com',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        subscription_tier_display: 'SuperGrok',
      }), { status: 200 }));

    const usage = await fetchXaiUsage('subscription-token', {
      fetch: request as typeof fetch,
      now: () => new Date('2026-08-12T00:00:00Z'),
    });

    expect(usage.plan).toBe('SuperGrok');
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'https://cli-chat-proxy.grok.com/v1/user',
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      'https://cli-chat-proxy.grok.com/v1/settings',
    ]);
    const identityHeaders = new Headers(request.mock.calls[0]?.[1]?.headers);
    const billingHeaders = new Headers(request.mock.calls[1]?.[1]?.headers);
    expect(identityHeaders.get('authorization')).toBe('Bearer subscription-token');
    expect(identityHeaders.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(billingHeaders.get('x-userid')).toBe('user-123');
    expect(billingHeaders.get('x-email')).toBe('person@example.com');
  });

  it('does not request billing when account identity is invalid', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ userId: 'bad\nheader' }), { status: 200 }),
    );
    await expect(fetchXaiUsage('subscription-token', { fetch: request as typeof fetch }))
      .rejects.toThrow('identity response is invalid');
    expect(request).toHaveBeenCalledOnce();
  });
});
