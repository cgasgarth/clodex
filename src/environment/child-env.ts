import { CONFLICTING_ENV_VARS } from '../constants.js';
import { claudeCodeClientModelId, stripOneMContextSuffix } from '../models/context-model-id.js';
import { resolveContextWindow } from '../models/context-window.js';
import type { ConflictInfo } from '../types.js';
import {
  applyClaudeProxyReliabilityEnv,
  applyClodexClaudeFastModeEnv,
  removeAnthropicProxyBypass,
} from '../runtime/wrapper-env.js';

export function detectConflicts(): ConflictInfo[] {
  return CONFLICTING_ENV_VARS.filter(name => process.env[name] !== undefined).map(name => ({
    name,
    value: process.env[name]!,
  }));
}

/** Restore first-party-like Claude Code behavior when routing through a proxy or gateway. */
function applyClaudeCodeThirdPartyCompat(env: NodeJS.ProcessEnv): void {
  // Custom ANTHROPIC_BASE_URL disables MCP tool search by default, loading every
  // MCP tool (100+) on every turn. Requires defer_loading on tools — do not set
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS when using the local translation proxy.
  env['ENABLE_TOOL_SEARCH'] = 'true';
  // Third-party routes may enable a shorter system prompt that drops conversational
  // guardrails while hooks/plugins still inject agentic instructions.
  env['CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT'] = '0';
  // Claude Code's own stream watchdog defaults to five minutes. Long Codex
  // reasoning turns can legitimately stay quiet longer, so clodex launches use
  // the supported env override rather than changing provider or daemon timers.
  applyClaudeProxyReliabilityEnv(env);
  applyClodexClaudeFastModeEnv(env);
}

export function buildChildEnv(
  baseUrl: string,
  model: string,
  apiKey: string,
  proxyPort?: number,
  contextWindow?: number,
  enableGatewayDiscovery?: boolean,
  nativeContextOwner = false,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CONFLICTING_ENV_VARS) {
    delete env[name];
  }
  env['ANTHROPIC_BASE_URL'] = proxyPort
    ? `http://127.0.0.1:${proxyPort}`
    : baseUrl;
  env['ANTHROPIC_API_KEY'] = apiKey;
  const bareModel = stripOneMContextSuffix(model);
  env['ANTHROPIC_MODEL'] = claudeCodeClientModelId(model, contextWindow);
  // Claude Code defaults to 200K for non-api.anthropic.com base URLs; override with
  // the launch model's real window. NOTE: in switch-menu mode this is fixed at launch
  // and does NOT update on live /model switch — Claude Code's gateway model discovery
  // only carries id + display_name (no context_window), so this env var is the only
  // lever and it reflects the model you started with.
  // Third-party routes also require a `[1m]` model-id suffix for 1M+ windows in the UI.
  env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = String(resolveContextWindow(bareModel, contextWindow));
  // Native Responses compaction owns the model-facing context for translated
  // routes; Claude's local transcript counter must not auto-compact or block it.
  delete env['CLODEX_NATIVE_CONTEXT_OWNER'];
  if (nativeContextOwner) env['CLODEX_NATIVE_CONTEXT_OWNER'] = '1';
  if (enableGatewayDiscovery) {
    env['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'] = '1';
  }
  applyClaudeCodeThirdPartyCompat(env);
  return env;
}

/**
 * Child env for transparent HTTP-proxy mode. Keep normal Anthropic credentials
 * intact, remove only endpoint modes that would bypass api.anthropic.com, and
 * trust the per-user clodex CA for this child process.
 */
export function buildHttpProxyChildEnv(proxyPort: number, caCertPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Bun's process.env proxy does not enumerate variables assigned after process
  // startup. Read the known proxy-bypass keys directly before filtering them.
  for (const name of ['NO_PROXY', 'no_proxy'] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of CONFLICTING_ENV_VARS) {
    if (name === 'ANTHROPIC_API_KEY' || name === 'ANTHROPIC_AUTH_TOKEN' || name === 'ANTHROPIC_MODEL') continue;
    delete env[name];
  }
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  env['HTTPS_PROXY'] = proxyUrl;
  env['HTTP_PROXY'] = proxyUrl;
  env['https_proxy'] = proxyUrl;
  env['http_proxy'] = proxyUrl;
  env['NODE_EXTRA_CA_CERTS'] = caCertPath;
  removeAnthropicProxyBypass(env);
  applyClaudeProxyReliabilityEnv(env);
  applyClodexClaudeFastModeEnv(env);
  return env;
}
