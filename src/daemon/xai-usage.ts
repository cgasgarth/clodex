import { VERSION } from '../constants.js';
import { PROVIDER_METADATA_TIMEOUT_MS } from '../timeouts.js';

const XAI_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription';
const XAI_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const XAI_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';
const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;

export interface XaiUsageSnapshot {
  fetchedAt: string;
  email?: string;
  accountId?: string;
  plan?: string;
  period?: 'weekly' | 'monthly' | 'usage';
  usedPercent?: number;
  resetAt?: number;
  usedCents?: number;
  limitCents?: number;
  onDemandUsedCents?: number;
  onDemandLimitCents?: number;
  prepaidBalanceCents?: number;
}

export interface XaiIdentity {
  email?: string;
  accountId: string;
  plan?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedCents(value: unknown): number | undefined {
  const cents = record(value);
  if (!cents) return undefined;
  const amount = cents.val ?? 0;
  return typeof amount === 'number'
    && Number.isSafeInteger(amount)
    && Math.abs(amount) <= 1_000_000_000_000
    ? Math.abs(amount)
    : undefined;
}

function boundedPercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function resetAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.round(millis / 1000) : undefined;
}

function usagePeriod(value: unknown): 'weekly' | 'monthly' | 'usage' | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.includes('WEEKLY')) return 'weekly';
  if (value.includes('MONTHLY')) return 'monthly';
  return 'usage';
}

export function parseXaiUsage(
  value: unknown,
  settingsValue: unknown,
  now = new Date(),
): XaiUsageSnapshot {
  const root = record(value);
  if (!root) throw new Error('xAI usage response is not an object');
  const settings = record(settingsValue);
  const config = record(root.config);
  const usedCents = boundedCents(config?.used);
  const limitCents = boundedCents(config?.monthlyLimit);
  const reportedPercent = boundedPercent(config?.creditUsagePercent);
  const derivedPercent = usedCents !== undefined && limitCents && limitCents > 0
    ? Math.min(100, usedCents / limitCents * 100)
    : undefined;
  const currentPeriod = record(config?.currentPeriod);
  const periodResetAt = resetAt(currentPeriod?.end ?? config?.billingPeriodEnd);
  // proto3 omits a zero-valued creditUsagePercent. A current period with no
  // percentage or legacy cents therefore means 0%, not unknown usage.
  const usedPercent = reportedPercent ?? derivedPercent ?? (currentPeriod ? 0 : undefined);
  const period = usagePeriod(currentPeriod?.type);
  const onDemandUsedCents = boundedCents(config?.onDemandUsed);
  const onDemandLimitCents = boundedCents(config?.onDemandCap);
  const prepaidBalanceCents = boundedCents(config?.prepaidBalance);
  const settingsPlan = settings?.subscription_tier_display ?? settings?.subscription_tier;
  // Settings reflects subscription upgrades sooner than the billing response.
  const planValue = settingsPlan ?? root.subscriptionTier;
  const plan = typeof planValue === 'string' && planValue.trim()
    ? planValue.trim().slice(0, 80)
    : undefined;
  return {
    fetchedAt: now.toISOString(),
    ...(plan ? { plan } : {}),
    ...(period ? { period } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(periodResetAt !== undefined ? { resetAt: periodResetAt } : {}),
    ...(usedCents !== undefined ? { usedCents } : {}),
    ...(limitCents !== undefined ? { limitCents } : {}),
    ...(onDemandUsedCents !== undefined ? { onDemandUsedCents } : {}),
    ...(onDemandLimitCents !== undefined ? { onDemandLimitCents } : {}),
    ...(prepaidBalanceCents !== undefined ? { prepaidBalanceCents } : {}),
  };
}

function usageHeaders(
  accessToken: string,
  identity?: { userId: string; email?: string },
): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `clodex/${VERSION}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-identifier': 'clodex',
    'x-grok-client-version': VERSION,
    'x-grok-client-mode': process.stdin.isTTY && process.stdout.isTTY ? 'interactive' : 'headless',
    ...(identity ? { 'x-userid': identity.userId } : {}),
    ...(identity?.email ? { 'x-email': identity.email } : {}),
  };
}

async function getJson(
  url: string,
  accessToken: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  identity?: { userId: string; email?: string },
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: usageHeaders(accessToken, identity),
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`xAI usage request failed (${response.status})`);
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_USAGE_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('xAI usage response is too large');
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_USAGE_RESPONSE_BYTES) {
    throw new Error('xAI usage response is too large');
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('xAI usage response is invalid JSON');
  }
}

function parseXaiIdentity(value: unknown): XaiIdentity {
  const identity = record(value);
  const userId = identity?.userId;
  if (
    typeof userId !== 'string'
    || !userId
    || userId.length > 256
    || !/^[\x21-\x7e]+$/.test(userId)
  ) {
    throw new Error('xAI account identity response is invalid');
  }
  const emailValue = identity.email;
  const email = typeof emailValue === 'string'
    && emailValue.length <= 320
    && /^[\x20-\x7e]+$/.test(emailValue)
    ? emailValue.toLowerCase()
    : undefined;
  const planValue = identity.subscriptionTier;
  const plan = typeof planValue === 'string' && planValue.trim()
    ? planValue.trim().slice(0, 80)
    : undefined;
  return {
    accountId: userId,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

export async function fetchXaiIdentity(
  accessToken: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<XaiIdentity> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PROVIDER_METADATA_TIMEOUT_MS,
  );
  timer.unref();
  try {
    return parseXaiIdentity(await getJson(
      XAI_USER_URL,
      accessToken,
      controller.signal,
      options.fetch ?? fetch,
    ));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchXaiUsage(
  accessToken: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date } = {},
): Promise<XaiUsageSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PROVIDER_METADATA_TIMEOUT_MS,
  );
  timer.unref();
  const fetchImpl = options.fetch ?? fetch;
  try {
    const identity = parseXaiIdentity(await getJson(
      XAI_USER_URL,
      accessToken,
      controller.signal,
      fetchImpl,
    ));
    const requestIdentity = {
      userId: identity.accountId,
      ...(identity.email ? { email: identity.email } : {}),
    };
    const [billing, settings] = await Promise.all([
      getJson(XAI_BILLING_URL, accessToken, controller.signal, fetchImpl, requestIdentity),
      getJson(XAI_SETTINGS_URL, accessToken, controller.signal, fetchImpl, requestIdentity),
    ]);
    return {
      ...parseXaiUsage(billing, settings, options.now?.() ?? new Date()),
      ...identity,
    };
  } finally {
    clearTimeout(timer);
  }
}
