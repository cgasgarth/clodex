// src/runtime/wrapper-env.ts
//
// Pure env computation for the `clodex-claude` wrapper bin. Given the process
// env and a live `clodex server` runtime state (or null), returns the env to
// launch the Claude Code binary with. Kept dependency-free so the wrapper
// stays tiny and fast — it runs for every Claude-Code-spawned agent process.

import type { ServerRuntimeState } from './server-runtime.js';

const PROXY_ENV_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const;
const REQUIRE_SERVER_ENV = 'CLODEX_REQUIRE_SERVER';
const LAUNCH_TICKET_ENV = 'CLODEX_LAUNCH_TICKET';
export const LAUNCH_TICKET_HEADER = 'x-clodex-launch-ticket';
export const CLAUDE_STREAM_IDLE_TIMEOUT_MS = 15 * 60_000;

export function applyClaudeProxyReliabilityEnv(env: NodeJS.ProcessEnv): void {
  env['CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'] = '1';
  applyClaudeStreamIdleTimeout(env);
}

export function applyClaudeStreamIdleTimeout(env: NodeJS.ProcessEnv): void {
  const configured = Number(env['CLAUDE_STREAM_IDLE_TIMEOUT_MS']);
  if (!Number.isFinite(configured) || configured < CLAUDE_STREAM_IDLE_TIMEOUT_MS) {
    env['CLAUDE_STREAM_IDLE_TIMEOUT_MS'] = String(CLAUDE_STREAM_IDLE_TIMEOUT_MS);
  }
}

export function setAnthropicCustomHeader(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string | undefined,
): void {
  const normalizedName = name.toLowerCase();
  const existing = (env['ANTHROPIC_CUSTOM_HEADERS'] ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => {
      const separator = line.indexOf(':');
      return separator < 0 || line.slice(0, separator).trim().toLowerCase() !== normalizedName;
    });
  if (value !== undefined) {
    if (/[\r\n]/.test(value)) throw new Error(`Invalid ${name} header value`);
    existing.push(`${name}: ${value}`);
  }
  if (existing.length > 0) {
    env['ANTHROPIC_CUSTOM_HEADERS'] = existing.join('\n');
  } else {
    delete env['ANTHROPIC_CUSTOM_HEADERS'];
  }
}

export function removeAnthropicProxyBypass(env: NodeJS.ProcessEnv): void {
  const noProxyValues = [env['NO_PROXY'], env['no_proxy']]
    .filter((value): value is string => value !== undefined);
  if (noProxyValues.length === 0) return;

  const filtered = [...new Set(noProxyValues
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => {
      const entry = value.toLowerCase().replace(/^https?:\/\//, '');
      const host = entry.replace(/:\d+$/, '');
      if (host === '*') return false;
      const suffix = host.startsWith('*.') ? host.slice(1) : host;
      const bypassesAnthropic = suffix.startsWith('.')
        ? 'api.anthropic.com'.endsWith(suffix)
        : 'api.anthropic.com' === suffix || 'api.anthropic.com'.endsWith(`.${suffix}`);
      return !bypassesAnthropic;
    }))]
    .join(',');
  if (filtered) {
    env['NO_PROXY'] = filtered;
    env['no_proxy'] = filtered;
  } else {
    delete env['NO_PROXY'];
    delete env['no_proxy'];
  }
}

export function wrapperRequiresServer(env: NodeJS.ProcessEnv): boolean {
  return env[REQUIRE_SERVER_ENV] === '1';
}

export function computeWrapperEnv(
  baseEnv: NodeJS.ProcessEnv,
  state: ServerRuntimeState | null,
  launchTicket?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // No live server: launch claude completely untouched — a down server must
  // never break launching claude.
  if (!state) return env;

  if (state.mode === 'proxy') {
    // Selective MITM: claude keeps its own Anthropic credentials; the proxy
    // routes clodex:/alias models to OpenAI and passes everything else through.
    const ticket = launchTicket ?? env[LAUNCH_TICKET_ENV];
    const proxyUrl = ticket
      ? `http://clodex:${encodeURIComponent(ticket)}@127.0.0.1:${state.port}`
      : `http://127.0.0.1:${state.port}`;
    if (ticket) env[LAUNCH_TICKET_ENV] = ticket;
    delete env['ANTHROPIC_BASE_URL'];
    for (const name of PROXY_ENV_VARS) env[name] = proxyUrl;
    if (state.caPath) env['NODE_EXTRA_CA_CERTS'] = state.caPath;
    removeAnthropicProxyBypass(env);
    applyClaudeProxyReliabilityEnv(env);
    return env;
  }

  // Endpoint gateway: all traffic goes to the local Anthropic-format gateway.
  for (const name of PROXY_ENV_VARS) delete env[name];
  env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${state.port}/anthropic`;
  const ticket = launchTicket ?? env[LAUNCH_TICKET_ENV];
  if (ticket) {
    env[LAUNCH_TICKET_ENV] = ticket;
    setAnthropicCustomHeader(env, LAUNCH_TICKET_HEADER, ticket);
  } else {
    setAnthropicCustomHeader(env, LAUNCH_TICKET_HEADER, undefined);
  }
  applyClaudeProxyReliabilityEnv(env);
  return env;
}
