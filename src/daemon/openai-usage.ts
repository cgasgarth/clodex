import { PROVIDER_METADATA_TIMEOUT_MS } from '../timeouts.js';

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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value: unknown): OpenAiUsageWindow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const window = value as Record<string, unknown>;
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
): { primary?: OpenAiUsageWindow; weekly?: OpenAiUsageWindow } {
  const windows = [first, second].filter(
    (window): window is OpenAiUsageWindow => window !== undefined,
  );
  const weekly = windows.find(window => window.limitWindowSeconds >= 6 * 24 * 60 * 60);
  const primary = windows.find(window => window !== weekly);
  return {
    ...(primary ? { primary } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

export function parseOpenAiUsage(
  value: unknown,
  now = new Date(),
): OpenAiUsageSnapshot {
  if (!value || typeof value !== 'object') throw new Error('OpenAI usage response is not an object');
  const root = value as Record<string, unknown>;
  const rateLimit = root.rate_limit && typeof root.rate_limit === 'object'
    ? root.rate_limit as Record<string, unknown>
    : {};
  const credits = root.credits && typeof root.credits === 'object'
    ? root.credits as Record<string, unknown>
    : undefined;
  const additional = Array.isArray(root.additional_rate_limits)
    ? root.additional_rate_limits.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const itemLimit = record.rate_limit && typeof record.rate_limit === 'object'
          ? record.rate_limit as Record<string, unknown>
          : {};
        const { primary, weekly } = classifyWindows(
          parseWindow(itemLimit.primary_window),
          parseWindow(itemLimit.secondary_window),
        );
        const name = typeof record.limit_name === 'string'
          ? record.limit_name.slice(0, 100)
          : undefined;
        const feature = typeof record.metered_feature === 'string'
          ? record.metered_feature.slice(0, 100)
          : undefined;
        if (!name && !feature && !primary && !weekly) return [];
        return [{
          ...(name ? { name } : {}),
          ...(feature ? { feature } : {}),
          ...(primary ? { primary } : {}),
          ...(weekly ? { weekly } : {}),
        }];
      })
    : [];
  const windows = classifyWindows(
    parseWindow(rateLimit.primary_window),
    parseWindow(rateLimit.secondary_window),
  );
  return {
    fetchedAt: now.toISOString(),
    ...(typeof root.plan_type === 'string' ? { plan: root.plan_type.slice(0, 100) } : {}),
    ...windows,
    ...(credits
      ? {
          credits: {
            ...(typeof credits.has_credits === 'boolean' ? { hasCredits: credits.has_credits } : {}),
            ...(typeof credits.unlimited === 'boolean' ? { unlimited: credits.unlimited } : {}),
            ...(finiteNumber(credits.balance) !== undefined ? { balance: finiteNumber(credits.balance) } : {}),
          },
        }
      : {}),
    additional,
  };
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
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'codex-cli',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenAI usage request failed (${response.status})`);
    return parseOpenAiUsage(await response.json(), options.now?.() ?? new Date());
  } finally {
    clearTimeout(timer);
  }
}
