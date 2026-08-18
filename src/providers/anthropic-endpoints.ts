import { isObject } from '../runtime/type-guards.js';
const MESSAGE_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const GATEWAY_PREFIX = '/anthropic';

export type AnthropicMessagesEndpoint = 'messages' | 'count_tokens';

/**
 * Claude's background-process wrapper addresses the shared daemon through its
 * Anthropic namespace, while foreground launches use the daemon root. Treat
 * both forms as the same protocol surface.
 */
export function normalizeAnthropicGatewayPath(path: string): string {
  return path.startsWith(`${GATEWAY_PREFIX}/`)
    ? path.slice(GATEWAY_PREFIX.length)
    : path;
}

/** Match Anthropic message endpoints by pathname, never by a shared prefix. */
export function anthropicMessagesEndpoint(url: string | undefined): AnthropicMessagesEndpoint | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://relay.local').pathname;
  } catch {
    return null;
  }
  const normalizedPathname = normalizeAnthropicGatewayPath(pathname);
  if (normalizedPathname === MESSAGE_PATH) return 'messages';
  if (normalizedPathname === COUNT_TOKENS_PATH) return 'count_tokens';
  return null;
}

const NON_CONTEXT_FIELDS = new Set([
  'model',
  'stream',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
]);

/**
 * Rough vision-input cost per image. Images are forwarded as real image parts
 * (never inline base64 text), so they cost tile-based vision tokens — for a
 * typical screenshot on GPT-family and Claude models that lands around 1-2k.
 */
export const IMAGE_INPUT_TOKEN_ESTIMATE = 1600;

function isAnthropicImageBlock<Value>(value: Value): boolean {
  if (!value || !isObject(value) || Array.isArray(value)) return false;
  return 'type' in value
    && value.type === 'image'
    && 'source' in value
    && Boolean(value.source)
    && isObject(value.source);
}

/**
 * Provider-neutral local estimate for translated models, whose SDKs do not expose
 * a token-count API. It is intentionally conservative and, unlike inference, is
 * immediate, local, free, and side-effect free. Claude Code labels /context counts
 * as estimates already.
 *
 * Image blocks (top-level or inside tool_result content) are excluded from the
 * bytes/4 text heuristic — base64 payloads are huge but are delivered as vision
 * parts — and counted at a flat per-image estimate instead.
 */
export function estimateAnthropicInputTokens<Body extends object>(body: Body): number {
  const contextBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => !NON_CONTEXT_FIELDS.has(key)),
  );
  let imageCount = 0;
  const serialized = JSON.stringify(contextBody, (_key, value) => {
    if (isAnthropicImageBlock(value)) {
      imageCount += 1;
      return { type: 'image' };
    }
    return value;
  });
  if (!serialized || serialized === '{}') return 0;
  const textTokens = Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4);
  return Math.max(1, textTokens + imageCount * IMAGE_INPUT_TOKEN_ESTIMATE);
}

/** Anthropic-compatible message for an upstream context-length rejection. */
export function anthropicPromptTooLongMessage<Body extends object>(body: Body, contextWindow: number): string {
  const maximum = Math.max(1, Math.floor(contextWindow));
  // The translated providers do not expose an exact token-count endpoint. Keep the
  // message structurally compatible with Anthropic while ensuring the rejected
  // prompt count is represented as larger than the advertised maximum.
  const estimatedPromptTokens = estimateAnthropicInputTokens(body);
  const promptTokens = Math.max(estimatedPromptTokens, maximum + 1);
  return `prompt is too long: ${promptTokens} tokens > ${maximum} maximum`;
}
