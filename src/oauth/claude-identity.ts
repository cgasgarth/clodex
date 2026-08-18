// src/oauth/claude-identity.ts — Request identity simulation for Claude Code OAuth.
// Anthropic validates that OAuth requests match the claude-cli fingerprint.

import { createHash, randomUUID } from 'node:crypto';
import { isObject, isString } from '../runtime/type-guards.js';
import type { ProviderDataValue } from '../types.js';

export const CLAUDE_CODE_CLI_VERSION = '2.1.195';
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_CLI_VERSION} (external, cli)`;
const CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli';
export const CLAUDE_CODE_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';

// Per-process session IDs keyed by seed — same value emitted for X-Claude-Code-Session-Id
// and metadata.user_id.session_id.
const sessionCache = new Map<string, string>();

function getOrCreateSessionId(seed: string): string {
  let id = sessionCache.get(seed);
  if (!id) { id = randomUUID(); sessionCache.set(seed, id); }
  return id;
}

// Deterministic UUIDv4 from a SHA-256 hash — used as fallback when bootstrap hasn't run.
function uuidFromHash(input: string): string {
  const h = createHash('sha256').update(input).digest('hex');
  return [h.slice(0,8), h.slice(8,12), '4'+h.slice(13,16),
    ((parseInt(h[16]!,16)&3)|8).toString(16)+h.slice(17,20), h.slice(20,32)].join('-');
}

const HEX64_RE = /^[a-f0-9]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve cliUserID (device_id) from stored providerData, falling back to a hash. */
function resolveCliUserID(
  providerData: Record<string, ProviderDataValue> | undefined,
  seed: string,
): string {
  const v = providerData?.cliUserID;
  if (isString(v) && HEX64_RE.test(v)) return v;
  return createHash('sha256').update(`cliUserID:${seed}`).digest('hex');
}

/** Resolve accountUUID from stored providerData, falling back to a deterministic UUID. */
function resolveAccountUUID(
  providerData: Record<string, ProviderDataValue> | undefined,
  seed: string,
): string {
  const v = providerData?.accountUUID;
  if (isString(v) && UUID_RE.test(v)) return v;
  return uuidFromHash(`account:${seed}`);
}

function buildUserIdJson(deviceId: string, accountUUID: string, sessionId: string): string {
  return JSON.stringify({ device_id: deviceId, account_uuid: accountUUID, session_id: sessionId });
}

function buildClaudeCodeBillingSystemLine(): string {
  return `${CLAUDE_CODE_BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_CLI_VERSION}.0; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`;
}

interface ClaudeBillingSystemBlock {
  text?: string;
}

interface ClaudeBillingRequestBody {
  system?: string | Array<string | ClaudeBillingSystemBlock> | null;
}

interface ClaudeToolMarker {}

interface ClaudeBetaRequestBody extends ClaudeBillingRequestBody {
  tools?: ClaudeToolMarker[];
  model?: string;
}

function systemBlockText<Value>(block: Value): string | undefined {
  if (isString(block)) return block;
  if (isObject(block) && 'text' in block) {
    const text = block.text;
    return isString(text) ? text : undefined;
  }
  return undefined;
}

function hasClaudeCodeBillingSystemLine<Value>(system: Value): boolean {
  if (isString(system)) return system.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX);
  if (!Array.isArray(system)) return false;
  return system.some(block => systemBlockText(block)?.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX));
}

export function injectClaudeCodeBillingSystemLine(body: ClaudeBillingRequestBody): void {
  if (hasClaudeCodeBillingSystemLine(body.system)) return;

  const billingBlock = { type: 'text', text: buildClaudeCodeBillingSystemLine() };
  if (body.system === undefined || body.system === null) {
    body.system = [billingBlock];
  } else if (isString(body.system)) {
    body.system = [billingBlock, { type: 'text', text: body.system }];
  } else if (Array.isArray(body.system)) {
    body.system = [billingBlock, ...body.system];
  } else {
    body.system = [billingBlock];
  }
}

// ── Beta flag selection ────────────────────────────────────────────────────
// Anthropic validates the anthropic-beta set matches the request shape.

const ALWAYS: string[] = [
  'oauth-2025-04-20',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
];
const AGENT: string[] = [
  'claude-code-20250219',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
  'advisor-tool-2026-03-01',
];
const THINKING: string[] = [
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13',
];
const HEAVY: string[] = ['advanced-tool-use-2025-11-20', 'effort-2025-11-24'];
const OPUS_ONLY: string[] = ['context-1m-2025-08-07', 'mid-conversation-system-2026-04-07'];

/**
 * Select anthropic-beta flags matching the request shape.
 * clientBeta: the inbound anthropic-beta header from the client — respected to avoid
 * forcing betas the client never requested (can cause malformed tool_use streams).
 */
export function selectBetaFlags(
  body: ClaudeBetaRequestBody,
  model?: string | null,
  clientBeta?: string | null,
): string {
  const hasSystem = !!body.system &&
    (isString(body.system) || (Array.isArray(body.system) && body.system.length > 0));
  const tools = body.tools;
  const isFullAgent = hasSystem && Array.isArray(tools) && tools.length > 0;
  const m = (model ?? (isString(body.model) ? body.model : '')).toLowerCase();
  const isOpus = m.includes('opus');
  const isSonnetOrOpus = isOpus || m.includes('sonnet');

  const clientSet = clientBeta
    ? new Set(clientBeta.split(',').map(s => s.trim()).filter(Boolean))
    : null;
  const allowThinking = !clientSet || clientSet.has('interleaved-thinking-2025-05-14');
  const allowHeavy = !clientSet
    || clientSet.has('advanced-tool-use-2025-11-20')
    || clientSet.has('effort-2025-11-24');

  const flags = [...ALWAYS];
  if (isFullAgent) flags.push(...AGENT);
  if (isOpus) flags.push(...OPUS_ONLY);
  if (allowThinking) flags.push(...THINKING);
  if (isFullAgent && isSonnetOrOpus && allowHeavy) flags.push(...HEAVY);

  return flags.join(',');
}

/**
 * Inject Claude Code identity metadata into an Anthropic request body in-place.
 * Must be called before forwarding the request to api.anthropic.com.
 */
export interface ClaudeIdentity {
  sessionId: string;
  userId: string;
}

export function injectClaudeIdentity<Body extends { metadata?: { user_id?: unknown } }>(
  body: Body,
  providerData: Record<string, ProviderDataValue> | undefined,
  seed: string,
): ClaudeIdentity {
  const deviceId = resolveCliUserID(providerData, seed);
  const accountUUID = resolveAccountUUID(providerData, seed);
  const sessionId = getOrCreateSessionId(seed);
  const userId = buildUserIdJson(deviceId, accountUUID, sessionId);
  Object.assign(body, { metadata: { ...body.metadata, user_id: userId } });
  return { sessionId, userId };
}
