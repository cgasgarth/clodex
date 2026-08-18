import { isBoolean, isNumber, isObject, isString } from '../runtime/type-guards.js';
import { PROVIDER_METADATA_TIMEOUT_MS } from '../config/timeouts.js';
import type { JsonObject, JsonValue } from '../oauth/responses-websocket/types.js';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface OpenAiUsageWindow {
  usedPercent: number;
  resetAt: number;
  limitWindowSeconds: number;
}

export interface OpenAiUsageSnapshot {
  fetchedAt: string;
  plan?: string;
  primary?: OpenAiUsageWindow;
  weekly?: OpenAiUsageWindow;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: number;
  };
  additional: Array<{
    name?: string;
    feature?: string;
    primary?: OpenAiUsageWindow;
    weekly?: OpenAiUsageWindow;
  }>;
}

type FetchLike = typeof fetch;

interface OpenAiUsageInput extends JsonObject {
  plan_type?: JsonValue;
  rate_limit?: OpenAiRateLimitInput;
  credits?: OpenAiCreditsInput;
  additional_rate_limits?: (OpenAiAdditionalLimitInput | null)[];
}

interface OpenAiRateLimitInput extends JsonObject {
  primary_window?: OpenAiWindowInput;
  secondary_window?: OpenAiWindowInput;
}

interface OpenAiWindowInput extends JsonObject {
  used_percent?: JsonValue;
  reset_at?: JsonValue;
  limit_window_seconds?: JsonValue;
}

interface OpenAiCreditsInput extends JsonObject {
  has_credits?: JsonValue;
  unlimited?: JsonValue;
  balance?: JsonValue;
}

interface OpenAiAdditionalLimitInput extends JsonObject {
  limit_name?: JsonValue;
  metered_feature?: JsonValue;
  rate_limit?: OpenAiRateLimitInput;
}

interface ClassifiedWindows {
  primary?: OpenAiUsageWindow;
  weekly?: OpenAiUsageWindow;
}

function finiteNumber(value: JsonValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value: JsonValue): OpenAiUsageWindow | undefined {
  if (!value || !isObject(value) || Array.isArray(value)) return undefined;
  const window: OpenAiWindowInput = value;
  const usedPercent = finiteNumber(window.used_percent);
  const resetAt = finiteNumber(window.reset_at);
  const limitWindowSeconds = finiteNumber(window.limit_window_seconds);
  if (usedPercent === undefined || resetAt === undefined || limitWindowSeconds === undefined) {
    return undefined;
  }
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetAt: Math.max(0, Math.round(resetAt)),
    limitWindowSeconds: Math.max(0, Math.round(limitWindowSeconds)),
  };
}

function classifyWindows(
  first: OpenAiUsageWindow | undefined,
  second: OpenAiUsageWindow | undefined,
): ClassifiedWindows {
  const windows = [first, second].filter(
    (window): window is OpenAiUsageWindow => window !== undefined,
  );
  const weekly = windows.find(window => window.limitWindowSeconds >= 6 * 24 * 60 * 60);
  const primary = windows.find(window => window !== weekly);
  const classified: ClassifiedWindows = {};
  if (primary) classified.primary = primary;
  if (weekly) classified.weekly = weekly;
  return classified;
}

export function parseOpenAiUsage(
  value: JsonValue,
  now = new Date(),
): OpenAiUsageSnapshot {
  if (!value || !isObject(value) || Array.isArray(value)) {
    throw new Error('OpenAI usage response is not an object');
  }
  const root: OpenAiUsageInput = value;
  const rateLimit = root.rate_limit && isObject(root.rate_limit)
    ? root.rate_limit
    : {};
  const credits = root.credits && isObject(root.credits)
    ? root.credits
    : undefined;
  const additional = Array.isArray(root.additional_rate_limits)
    ? root.additional_rate_limits.flatMap(item => {
        if (!item) return [];
        const record = item;
        const itemLimit = record.rate_limit && isObject(record.rate_limit)
          ? record.rate_limit
          : {};
        const { primary, weekly } = classifyWindows(
          parseWindow(itemLimit.primary_window),
          parseWindow(itemLimit.secondary_window),
        );
        const name = isString(record.limit_name)
          ? String(record.limit_name).slice(0, 100)
          : undefined;
        const feature = isString(record.metered_feature)
          ? String(record.metered_feature).slice(0, 100)
          : undefined;
        if (!name && !feature && !primary && !weekly) return [];
        const limit: OpenAiUsageSnapshot['additional'][number] = {};
        if (name) limit.name = name;
        if (feature) limit.feature = feature;
        if (primary) limit.primary = primary;
        if (weekly) limit.weekly = weekly;
        return [limit];
      })
    : [];
  const windows = classifyWindows(
    parseWindow(rateLimit.primary_window),
    parseWindow(rateLimit.secondary_window),
  );
  const snapshot: OpenAiUsageSnapshot = {
    fetchedAt: now.toISOString(),
    additional,
  };
  if (isString(root.plan_type)) snapshot.plan = String(root.plan_type).slice(0, 100);
  if (windows.primary) snapshot.primary = windows.primary;
  if (windows.weekly) snapshot.weekly = windows.weekly;
  if (credits) {
    const parsedCredits: NonNullable<OpenAiUsageSnapshot['credits']> = {};
    const balance = finiteNumber(credits.balance);
    if (isBoolean(credits.has_credits)) parsedCredits.hasCredits = credits.has_credits;
    if (isBoolean(credits.unlimited)) parsedCredits.unlimited = credits.unlimited;
    if (balance !== undefined) parsedCredits.balance = balance;
    snapshot.credits = parsedCredits;
  }
  return snapshot;
}

export async function fetchOpenAiUsage(
  accessToken: string,
  accountId?: string,
  options: {
    fetch?: FetchLike;
    timeoutMs?: number;
    now?: () => Date;
  } = {},
): Promise<OpenAiUsageSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PROVIDER_METADATA_TIMEOUT_MS,
  );
  timer.unref();
  try {
    const response = await (options.fetch ?? fetch)(CODEX_USAGE_URL, {
      headers: (() => {
        const headers = new Headers({
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'User-Agent': 'codex-cli',
        });
        if (accountId) headers.set('ChatGPT-Account-Id', accountId);
        return headers;
      })(),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenAI usage request failed (${response.status})`);
    return parseOpenAiUsage(await response.json(), options.now?.() ?? new Date());
  } finally {
    clearTimeout(timer);
  }
}
