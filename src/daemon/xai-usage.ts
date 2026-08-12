import { VERSION } from '../constants.js';
import { PROVIDER_METADATA_TIMEOUT_MS } from '../timeouts.js';

const XAI_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user';
const XAI_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;

export interface XaiUsageSnapshot {
  fetchedAt: string;
  plan?: string;
  usedPercent?: number;
  resetAt?: number;
  usedCents?: number;
  limitCents?: number;
  onDemandUsedCents?: number;
  onDemandLimitCents?: number;
  prepaidBalanceCents?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedCents(value: unknown): number | undefined {
  const amount = record(value)?.val;
  return typeof amount === 'number'
    && Number.isSafeInteger(amount)
    && amount >= 0
    && amount <= 1_000_000_000_000
    ? amount
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

export function parseXaiUsage(value: unknown, now = new Date()): XaiUsageSnapshot {
  const root = record(value);
  if (!root) throw new Error('xAI usage response is not an object');
  const config = record(root.config);
  const usedCents = boundedCents(config?.used);
  const limitCents = boundedCents(config?.monthlyLimit);
  const reportedPercent = boundedPercent(config?.creditUsagePercent);
  const derivedPercent = usedCents !== undefined && limitCents && limitCents > 0
    ? Math.min(100, usedCents / limitCents * 100)
    : undefined;
  const currentPeriod = record(config?.currentPeriod);
  const periodResetAt = resetAt(currentPeriod?.end ?? config?.billingPeriodEnd);
  const usedPercent = reportedPercent ?? derivedPercent;
  const onDemandUsedCents = boundedCents(config?.onDemandUsed);
  const onDemandLimitCents = boundedCents(config?.onDemandCap);
  const prepaidBalanceCents = boundedCents(config?.prepaidBalance);
  const plan = typeof root.subscriptionTier === 'string' && root.subscriptionTier.trim()
    ? root.subscriptionTier.trim().slice(0, 80)
    : undefined;
  return {
    fetchedAt: now.toISOString(),
    ...(plan ? { plan } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(periodResetAt !== undefined ? { resetAt: periodResetAt } : {}),
    ...(usedCents !== undefined ? { usedCents } : {}),
    ...(limitCents !== undefined ? { limitCents } : {}),
    ...(onDemandUsedCents !== undefined ? { onDemandUsedCents } : {}),
    ...(onDemandLimitCents !== undefined ? { onDemandLimitCents } : {}),
    ...(prepaidBalanceCents !== undefined ? { prepaidBalanceCents } : {}),
  };
}

function usageHeaders(accessToken: string, userId?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `clodex/${VERSION}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': VERSION,
    'x-grok-client-mode': process.stdin.isTTY && process.stdout.isTTY ? 'interactive' : 'headless',
    ...(userId ? { 'x-userid': userId } : {}),
  };
}

async function getJson(
  url: string,
  accessToken: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  userId?: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: usageHeaders(accessToken, userId),
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
    const identity = record(await getJson(XAI_USER_URL, accessToken, controller.signal, fetchImpl));
    const userId = identity?.userId;
    if (
      typeof userId !== 'string'
      || !userId
      || userId.length > 256
      || !/^[\x21-\x7e]+$/.test(userId)
    ) {
      throw new Error('xAI account identity response is invalid');
    }
    const billing = await getJson(
      XAI_BILLING_URL,
      accessToken,
      controller.signal,
      fetchImpl,
      userId,
    );
    return parseXaiUsage(billing, options.now?.() ?? new Date());
  } finally {
    clearTimeout(timer);
  }
}
