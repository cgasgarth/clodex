import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import { VERSION } from '../constants.js';
import { PROVIDER_METADATA_TIMEOUT_MS } from '../config/timeouts.js';
import type { JsonObject, JsonValue } from '../oauth/responses-websocket/types.js';

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

interface XaiRequestIdentity {
  userId: string;
  email?: string;
}

function record(value: JsonValue): JsonObject | undefined {
  return value && isObject(value) && !Array.isArray(value)
    ? value
    : undefined;
}

function boundedCents(value: JsonValue): number | undefined {
  const cents = record(value);
  if (!cents) return undefined;
  const amount = cents.val ?? 0;
  return isNumber(amount)
    && Number.isSafeInteger(amount)
    && Math.abs(amount) <= 1_000_000_000_000
    ? Math.abs(amount)
    : undefined;
}

function boundedPercent(value: JsonValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function resetAt(value: JsonValue): number | undefined {
  if (!isString(value) || value.length > 64) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.round(millis / 1000) : undefined;
}

function usagePeriod(value: JsonValue): 'weekly' | 'monthly' | 'usage' | undefined {
  if (!isString(value)) return undefined;
  if (value.includes('WEEKLY')) return 'weekly';
  if (value.includes('MONTHLY')) return 'monthly';
  return 'usage';
}

export function parseXaiUsage(
  value: JsonValue,
  settingsValue: JsonValue,
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
  const plan = isString(planValue) && planValue.trim()
    ? planValue.trim().slice(0, 80)
    : undefined;
  const snapshot: XaiUsageSnapshot = {
    fetchedAt: now.toISOString(),
  };
  if (plan) snapshot.plan = plan;
  if (period) snapshot.period = period;
  if (usedPercent !== undefined) snapshot.usedPercent = usedPercent;
  if (periodResetAt !== undefined) snapshot.resetAt = periodResetAt;
  if (usedCents !== undefined) snapshot.usedCents = usedCents;
  if (limitCents !== undefined) snapshot.limitCents = limitCents;
  if (onDemandUsedCents !== undefined) snapshot.onDemandUsedCents = onDemandUsedCents;
  if (onDemandLimitCents !== undefined) snapshot.onDemandLimitCents = onDemandLimitCents;
  if (prepaidBalanceCents !== undefined) snapshot.prepaidBalanceCents = prepaidBalanceCents;
  return snapshot;
}

function usageHeaders(
  accessToken: string,
  identity?: { userId: string; email?: string },
): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `clodex/${VERSION}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-identifier': 'clodex',
    'x-grok-client-version': VERSION,
    'x-grok-client-mode': process.stdin.isTTY && process.stdout.isTTY ? 'interactive' : 'headless',
  });
  if (identity) headers.set('x-userid', identity.userId);
  if (identity?.email) headers.set('x-email', identity.email);
  return headers;
}

async function getJson(
  url: string,
  accessToken: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  identity?: { userId: string; email?: string },
): Promise<JsonValue> {
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
    const parsed: JsonValue = JSON.parse(body);
    return parsed;
  } catch {
    throw new Error('xAI usage response is invalid JSON');
  }
}

function parseXaiIdentity(value: JsonValue): XaiIdentity {
  const identity = record(value);
  const userId = identity?.userId;
  if (
    !isString(userId)
    || !userId
    || userId.length > 256
    || !/^[\x21-\x7e]+$/.test(userId)
  ) {
    throw new Error('xAI account identity response is invalid');
  }
  const emailValue = identity.email;
  const email = isString(emailValue)
    && emailValue.length <= 320
    && /^[\x20-\x7e]+$/.test(emailValue)
    ? emailValue.toLowerCase()
    : undefined;
  const planValue = identity.subscriptionTier;
  const plan = isString(planValue) && planValue.trim()
    ? planValue.trim().slice(0, 80)
    : undefined;
  const parsed: XaiIdentity = {
    accountId: userId,
  };
  if (email) parsed.email = email;
  if (plan) parsed.plan = plan;
  return parsed;
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
    const requestIdentity: XaiRequestIdentity = {
      userId: identity.accountId,
    };
    if (identity.email) requestIdentity.email = identity.email;
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
