import { PROVIDER_METADATA_TIMEOUT_MS } from '../timeouts.js';

const OPENAI_PROFILE_URL = 'https://api.openai.com/v1/me';

type FetchLike = typeof fetch;

export async function fetchOpenAiProfileEmail(
  accessToken: string,
  options: {
    fetch?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PROVIDER_METADATA_TIMEOUT_MS,
  );
  timer.unref();
  try {
    const response = await (options.fetch ?? fetch)(OPENAI_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'codex-cli',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenAI profile request failed (${response.status})`);
    const value = await response.json() as { email?: unknown };
    const email = typeof value.email === 'string'
      ? value.email.trim().toLowerCase()
      : '';
    return email.includes('@') ? email : undefined;
  } finally {
    clearTimeout(timer);
  }
}
