// Anthropic /v1/messages ↔ Vercel AI SDK. One turn per request; Claude Code owns the tool loop.
import { createHash } from 'node:crypto';
import { streamText, generateText, tool, jsonSchema } from 'ai';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  sseChunk,
  encodeToolUseId,
  splitToolUseId,
  serializeToolResultContent,
  silenceSdkWarnings,
  type FullStreamPart,
  grabRoundTripSignature,
} from './proxy-shared.js';
import {
  deepMergeProviderOptions,
  effortProviderOptions,
  thinkingProviderOptions,
  type ReasoningMetadata,
} from './provider-factory.js';
import { resolveUpstreamTools } from './tool-search.js';
import type { AnthropicRequestMessage } from './proxy-types.js';
import { anthropicErrorType, upstreamHttpStatus } from './upstream-error.js';
import { CLAUDE_CODE_BILLING_HEADER_PREFIX } from './oauth/claude-identity.js';
import {
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  MODEL_TOTAL_TIMEOUT_MS,
} from './timeouts.js';

export { silenceSdkWarnings };

export type SdkTranslationErrorSignature =
  | 'reasoning_part_not_found'
  | 'text_part_not_found';

/** Classify privacy-safe AI SDK stream-state errors without logging dynamic part ids. */
export function sdkTranslationErrorSignature(error: unknown): SdkTranslationErrorSignature | undefined {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : undefined;
  if (!message) return undefined;
  if (/\breasoning part \S+ not found\b/i.test(message)) return 'reasoning_part_not_found';
  if (/\btext part \S+ not found\b/i.test(message)) return 'text_part_not_found';
  return undefined;
}

// ── Anthropic request shapes (only the fields we read) ───────────────────────
interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  source?: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string };
  cache_control?: { type?: string; ttl?: string };
  // internal: resolved tool name for a tool_result, set by annotateToolNames
  _name?: string;
}
interface AnthropicMsg { role: 'user' | 'assistant' | 'system'; content: string | AnthropicBlock[]; }
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  cache_control?: { type?: string; ttl?: string };
  type?: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: {
    type?: string;
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
}
export interface AnthropicRequest {
  model: string;
  system?: string | Array<string | { text?: string; cache_control?: { type?: string; ttl?: string } }>;
  messages: AnthropicMsg[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  metadata?: { user_id?: unknown };
  diagnostics?: unknown;
  /** Claude native /fast state. Clodex consumes this instead of forwarding it. */
  speed?: 'standard' | 'fast';
}

export interface TranslateRequestOptions {
  /** Fallback when the client omits effort (e.g. Claude Desktop gateway). */
  defaultEffort?: string;
  reasoningMetadata?: ReasoningMetadata;
  /** ChatGPT Codex OAuth requires instructions and manages its own output limit. */
  openAiOAuth?: boolean;
  /** Effective request processing mode. Fast is valid only for ChatGPT Codex OAuth. */
  processingMode?: 'standard' | 'fast';
  /** Fallback session identity from X-Claude-Code-Session-Id. Body metadata wins. */
  claudeSessionId?: string;
  /** Hard cap on tools sent to the provider (e.g. Groq: 128). Excess tools are silently dropped. */
  maxTools?: number;
}

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validClaudeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return CLAUDE_SESSION_ID_RE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** Extract Claude Code's stable session UUID without accepting arbitrary metadata. */
export function extractClaudeSessionId(
  body: Pick<AnthropicRequest, 'metadata'>,
  headerFallback?: string,
): string | undefined {
  const userId = body.metadata?.user_id;
  if (typeof userId === 'string') {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown };
      const fromMetadata = validClaudeSessionId(parsed.session_id);
      if (fromMetadata) return fromMetadata;
    } catch {
      // Malformed or non-JSON metadata is ignored; the header remains usable.
    }
  }
  return validClaudeSessionId(headerFallback);
}

/** Opaque prompt-cache partition derived from a Claude session UUID. */
export function claudeSessionPromptCacheKey(sessionId: string): string {
  return 'relay-session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

/** Read reasoning effort from an Anthropic-format request body. */
export function anthropicEffortFromRequest(body: AnthropicRequest): string | undefined {
  const effort = body.output_config?.effort;
  if (typeof effort === 'string' && effort.trim()) return effort.trim();
  return undefined;
}

/**
 * Stable OpenAI `prompt_cache_key` derived from the request's cacheable prefix
 * (top-level system prompt + tool definitions). OpenAI caches prompt prefixes
 * automatically; this key routes requests that share that prefix to the same
 * cache partition, raising hit rate — important in server mode where many
 * concurrent Claude Code sessions share one relay process.
 *
 * Keyed only on the STABLE prefix: within one Claude Code session every turn
 * sends byte-identical system+tools → same key → warm routing, while distinct
 * sessions (a different date/cwd baked into the system prompt) get distinct
 * keys, which is correct since they share no cacheable prefix. Deliberately
 * excludes folded inline system-reminders — those carry per-request-volatile
 * content (fresh timestamps, injected context) that would churn the key every
 * turn and defeat grouping.
 */
function openAiPromptCacheKey(
  system: string | undefined,
  tools: AnthropicTool[] | undefined,
): string {
  const toolSig = (tools ?? [])
    .map(t => `${t.name}\x01${t.description ?? ''}\x01${JSON.stringify(t.input_schema)}`)
    .join('\x02');
  const material = `${system ?? ''}\0${toolSig}`;
  return 'relay-' + createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Public OpenAI models that implement explicit prompt-cache breakpoints. */
export function supportsOpenAiPromptCacheBreakpoints(modelId: string): boolean {
  const match = modelId.toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

export interface SdkCallParams {
  instructions?: string;
  messages: ModelMessage[];
  allowSystemInMessages?: boolean;
  tools?: ToolSet;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

// ── system ───────────────────────────────────────────────────────────────────
function stripClaudeCodeBillingHeader(text: string): string | undefined {
  if (!text.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX)) return text;
  const newline = text.indexOf('\n');
  return newline === -1 ? undefined : text.slice(newline + 1);
}

function systemToString(
  system: AnthropicRequest['system'],
  stripAnthropicBillingHeader = false,
): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') {
    return stripAnthropicBillingHeader ? stripClaudeCodeBillingHeader(system) : system;
  }
  const blocks = system.map(b => (typeof b === 'string' ? b : b.text ?? ''));
  if (!stripAnthropicBillingHeader) return blocks.join('\n');
  return blocks.flatMap(text => {
    const stripped = stripClaudeCodeBillingHeader(text);
    return stripped === undefined ? [] : [stripped];
  }).join('\n');
}

function inlineSystemToString(messages: AnthropicMsg[]): string | undefined {
  const text = messages
    .filter(message => message.role === 'system')
    .flatMap(message => {
      if (typeof message.content === 'string') return [message.content];
      return message.content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '');
    })
    .filter(value => value.trim())
    .join('\n');
  return text || undefined;
}

function joinInstructions(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part?.trim()));
  return present.length ? present.join('\n') : undefined;
}

const OPENAI_OAUTH_STEERING_POLICY = [
  'The user may send a new message while you are still working. When they do, evaluate whether',
  'they intended to replace the active request or add to it. If they intended to override or',
  'replace it, drop the previous work and focus on the new request. If the new message adds to',
  'unfinished work, address both. If it asks for status or another question, answer it and then',
  'continue only the work that remains relevant.',
].join(' ');

function openAiCacheBreakpoint(block: AnthropicBlock, enabled: boolean): Record<string, unknown> | undefined {
  if (!enabled || !block.cache_control) return undefined;
  return { openai: { promptCacheBreakpoint: { mode: 'explicit' } } };
}

function translateTopLevelSystemForOpenAi(
  system: AnthropicRequest['system'],
): ModelMessage[] {
  if (!system) return [];
  if (typeof system === 'string') {
    return system.trim() ? [{ role: 'system', content: system }] : [];
  }
  return system.flatMap(block => {
    const text = typeof block === 'string' ? block : block.text ?? '';
    if (!text.trim()) return [];
    const cacheControl = typeof block === 'string' ? undefined : block.cache_control;
    return [{
      role: 'system',
      content: text,
      ...(cacheControl
        ? { providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } }
        : {}),
    } as unknown as ModelMessage];
  });
}

// ── images ───────────────────────────────────────────────────────────────────
function imagePart(block: AnthropicBlock): {
  type: 'file';
  data: { type: 'data'; data: Uint8Array } | { type: 'url'; url: URL };
  mediaType: string;
} | null {
  const src = block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    return {
      type: 'file',
      data: { type: 'data', data: Buffer.from(src.data, 'base64') },
      mediaType: src.media_type ?? 'image',
    };
  }
  if (src.type === 'url' && src.url) {
    return {
      type: 'file',
      data: { type: 'url', url: new URL(src.url) },
      mediaType: src.media_type ?? 'image',
    };
  }
  return null;
}

/**
 * Serialize a tool_result for the text-only function-output channel, lifting
 * image blocks out into user-message parts (the caller pushes them right after
 * the tool message). Left inline, an image's base64 payload would be
 * JSON.stringify'd into the output text and tokenized as text at ~1.5 chars
 * per token — a single screenshot can cost 200k+ tokens upstream.
 */
function serializeToolResultForModel(
  tr: AnthropicBlock,
  imageParts: Array<Record<string, unknown>>,
): string {
  if (!Array.isArray(tr.content)) return serializeToolResultContent(tr.content);
  const rawId = splitToolUseId(tr.tool_use_id ?? '').rawId;
  let imageIndex = 0;
  const blocks = (tr.content as AnthropicBlock[]).map(block => {
    if (block.type !== 'image') return block;
    const part = imagePart(block);
    if (!part) return block;
    imageIndex += 1;
    const label = `image ${imageIndex} of tool call ${rawId}`;
    imageParts.push({ type: 'text', text: `The following image is ${label}:` }, part);
    return { type: 'image', note: `attached to the next user message as ${label}` };
  });
  return JSON.stringify(blocks);
}

// ── tool_result name resolution (tool messages need the tool name) ────────────
export function annotateToolNames(messages: AnthropicMsg[]): void {
  const nameById = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.id && b.name) nameById.set(splitToolUseId(b.id).rawId, b.name);
    }
  }
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        b._name = nameById.get(splitToolUseId(b.tool_use_id).rawId);
      }
    }
  }
}

function thinkingToSdkPart(
  block: AnthropicBlock,
  npm: string,
): Record<string, unknown> | null {
  const text = block.thinking ?? '';
  if (npm === '@ai-sdk/openai' && !block.signature && !text.trim()) return null;

  const part: Record<string, unknown> = { type: 'reasoning', text };
  if (block.signature) {
    if (npm === '@ai-sdk/google') {
      part.providerOptions = { google: { thoughtSignature: block.signature } };
    } else if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/openai-compatible') {
      part.providerOptions = { openai: { reasoningEncryptedContent: block.signature } };
    }
  }
  return part;
}

function cacheBreakpointOptions(
  block: AnthropicBlock,
  enabled: boolean,
): { providerOptions: Record<string, unknown> } | Record<string, never> {
  const providerOptions = openAiCacheBreakpoint(block, enabled);
  return providerOptions ? { providerOptions } : {};
}

function translateSystemBlocks(
  blocks: AnthropicBlock[],
  openAiPromptCacheBreakpoints: boolean,
): ModelMessage[] {
  return blocks.flatMap(block => {
    if (block.type !== 'text' || !block.text?.trim()) return [];
    return [{
      role: 'system',
      content: block.text,
      ...cacheBreakpointOptions(block, openAiPromptCacheBreakpoints),
    } as unknown as ModelMessage];
  });
}

const CLAUDE_MID_TURN_PREFIX = 'The user sent a new message while you were working:\n';
const CLAUDE_MID_TURN_SUFFIX = '\n\nThis is how Claude Code surfaces messages the user sends mid-turn — '
  + 'within the running turn, often alongside the next tool result, rather than as a separate '
  + 'conversation turn. Address the message above as you continue this turn.';

/**
 * Preserve Claude's mid-turn control semantics at user authority.
 *
 * The queued command is transient in Claude's transcript. Codex therefore gets
 * one model sample in which to act on it. Keep the human text opaque, but make
 * that boundary explicit instead of reducing it to an ordinary user message.
 */
function normalizeClaudeMidTurnInstruction(text: string): string | undefined {
  if (!text.startsWith(CLAUDE_MID_TURN_PREFIX) || !text.endsWith(CLAUDE_MID_TURN_SUFFIX)) {
    return undefined;
  }
  const instruction = text.slice(
    CLAUDE_MID_TURN_PREFIX.length,
    -CLAUDE_MID_TURN_SUFFIX.length,
  );
  return [
    'The user sent this new instruction while the current task was running.',
    'Treat it as the newest user request and apply it now before continuing earlier work.',
    'If it replaces, redirects, limits, or stops prior work, follow it immediately.',
    '',
    instruction,
  ].join('\n');
}

function translateUserBlocks(
  blocks: AnthropicBlock[],
  openAiPromptCacheBreakpoints: boolean,
  normalizeMidTurnSteering: boolean,
): ModelMessage[] {
  const imageParts: Array<Record<string, unknown>> = [];
  const toolResults = blocks.filter(block => block.type === 'tool_result');
  const messages: ModelMessage[] = [];
  if (toolResults.length > 0) {
    messages.push({
      role: 'tool',
      content: toolResults.map(result => ({
        type: 'tool-result',
        toolCallId: splitToolUseId(result.tool_use_id ?? '').rawId,
        toolName: result._name ?? 'unknown',
        output: { type: 'text', value: serializeToolResultForModel(result, imageParts) },
        ...cacheBreakpointOptions(result, openAiPromptCacheBreakpoints),
      })),
    } as unknown as ModelMessage);
  }

  const parts: Array<Record<string, unknown>> = [];
  const steeringParts: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = block.text ?? '';
      const midTurnInstruction = normalizeMidTurnSteering
        ? normalizeClaudeMidTurnInstruction(text)
        : undefined;
      const part = {
        type: 'text',
        text: midTurnInstruction ?? text,
        ...cacheBreakpointOptions(block, openAiPromptCacheBreakpoints),
      };
      // Codex queues steering as typed user input and places it last in the
      // next model sample. Keep the same model-visible ordering without
      // interpreting the human text.
      (midTurnInstruction === undefined ? parts : steeringParts).push(part);
      continue;
    }
    if (block.type !== 'image') continue;
    const image = imagePart(block);
    if (image) {
      parts.push({ ...image, ...cacheBreakpointOptions(block, openAiPromptCacheBreakpoints) });
    }
  }
  const userParts = [...imageParts, ...parts, ...steeringParts];
  if (userParts.length > 0) {
    messages.push({ role: 'user', content: userParts } as unknown as ModelMessage);
  }
  return messages;
}

function translateAssistantBlocks(
  blocks: AnthropicBlock[],
  npm: string,
): ModelMessage[] {
  const isGoogle = npm === '@ai-sdk/google';
  const parts = blocks.flatMap(block => {
    if (block.type === 'text') return [{ type: 'text', text: block.text ?? '' }];
    if (block.type === 'thinking') {
      const reasoning = thinkingToSdkPart(block, npm);
      return reasoning ? [reasoning] : [];
    }
    if (block.type !== 'tool_use' || !block.id) return [];
    const { rawId, thoughtSignature } = splitToolUseId(block.id);
    const toolCall: Record<string, unknown> = {
      type: 'tool-call',
      toolCallId: rawId,
      toolName: block.name,
      input: block.input ?? {},
    };
    if (thoughtSignature && isGoogle) {
      toolCall.providerOptions = { google: { thoughtSignature } };
    }
    return [toolCall];
  });
  return parts.length > 0
    ? [{ role: 'assistant', content: parts } as unknown as ModelMessage]
    : [];
}

// ── messages: Anthropic → SDK ModelMessage[] ─────────────────────────────────
export function translateMessages(
  messages: AnthropicMsg[],
  npm: string,
  openAiPromptCacheBreakpoints = false,
  normalizeMidTurnSteering = false,
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    const blocks: AnthropicBlock[] = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content;

    if (msg.role === 'system') {
      out.push(...translateSystemBlocks(blocks, openAiPromptCacheBreakpoints));
      continue;
    }
    if (msg.role === 'user') {
      out.push(...translateUserBlocks(
        blocks,
        openAiPromptCacheBreakpoints,
        normalizeMidTurnSteering,
      ));
      continue;
    }
    out.push(...translateAssistantBlocks(blocks, npm));
  }
  return out;
}

/**
 * Strip filler values GPT-family models emit for optional params instead of
 * omitting them: top-level `null` always, and empty arrays for properties the
 * tool's schema does not require. Claude Code forwards some tool inputs
 * verbatim into server-side API calls (e.g. WebSearch domain lists become the
 * `web_search` tool config, where an empty list is a 400), so filler must be
 * removed here. Required properties keep their empty arrays — there an empty
 * array is an intentional value (e.g. TodoWrite's `todos: []` clears the list).
 */
function sanitizeToolInput(
  input: Record<string, unknown>,
  requiredProps?: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null) continue;
    if (Array.isArray(v) && v.length === 0 && !requiredProps?.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Per-tool `required` property sets, read back out of the translated tool schemas. */
function toolRequiredProps(tools?: SdkCallParams['tools']): Map<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const [name, t] of Object.entries(tools ?? {})) {
    const schema = (t as { inputSchema?: { jsonSchema?: { required?: unknown } } }).inputSchema?.jsonSchema;
    const required = Array.isArray(schema?.required) ? schema.required : [];
    map.set(name, new Set(required.filter((r): r is string => typeof r === 'string')));
  }
  return map;
}

function isAnthropicWebSearchTool(toolDefinition: AnthropicTool): boolean {
  return toolDefinition.name === 'web_search'
    && toolDefinition.type?.startsWith('web_search_') === true;
}

function translateOpenAiWebSearchTool(toolDefinition: AnthropicTool) {
  if (toolDefinition.blocked_domains?.length) {
    throw new Error('OpenAI native web search does not support blocked_domains');
  }
  const location = toolDefinition.user_location;
  return openai.tools.webSearch({
    ...(toolDefinition.allowed_domains?.length
      ? { filters: { allowedDomains: toolDefinition.allowed_domains } }
      : {}),
    ...(location?.type === 'approximate'
      ? {
          userLocation: {
            type: 'approximate' as const,
            country: location.country,
            city: location.city,
            region: location.region,
            timezone: location.timezone,
          },
        }
      : {}),
  });
}

export function translateTools(
  anthropicTools?: AnthropicTool[],
  npm?: string,
): ToolSet | undefined {
  if (!anthropicTools?.length) return undefined;
  const tools: ToolSet = {};
  for (const t of anthropicTools) {
    if (npm === '@ai-sdk/openai' && isAnthropicWebSearchTool(t)) {
      tools[t.name] = translateOpenAiWebSearchTool(t);
      continue;
    }
    tools[t.name] = tool({
      description: t.description ?? '',
      inputSchema: jsonSchema(t.input_schema ?? { type: 'object', properties: {} }),
    });
  }
  return Object.keys(tools).length ? tools : undefined;
}

export function translateToolChoice(tc: AnthropicRequest['tool_choice']): SdkCallParams['toolChoice'] {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  return tc.name ? { type: 'tool', toolName: tc.name } : undefined;
}

const COMPACT_TEXT_ONLY_START = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.';
const COMPACT_TEXT_ONLY_END = 'REMINDER: Do NOT call any tools. Respond with plain text only';

/** Detect Claude Code's observed plain-text compaction envelope. */
export function isClaudeCodeCompactRequest(body: AnthropicRequest): boolean {
  if (body.diagnostics !== undefined) return false;

  const finalMessage = body.messages.at(-1);
  if (!finalMessage || finalMessage.role !== 'user') return false;
  const text = typeof finalMessage.content === 'string'
    ? finalMessage.content
    : finalMessage.content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n');
  return text.includes(COMPACT_TEXT_ONLY_START) && text.includes(COMPACT_TEXT_ONLY_END);
}

/**
 * Classify the structured-output subset for callers that need to distinguish
 * it. Translation now treats every recognized compact envelope as a plain-text
 * turn; the marker pair keeps ordinary structured-output requests unchanged.
 */
export function isClaudeCodeStructuredOutputCompactRequest(body: AnthropicRequest): boolean {
  return body.tools?.some(candidate => candidate.name === 'StructuredOutput') === true
    && isClaudeCodeCompactRequest(body);
}

export function translateRequest(
  body: AnthropicRequest,
  npm: string,
  options?: TranslateRequestOptions,
): SdkCallParams {
  const messages = body.messages;
  annotateToolNames(messages);

  // Claude Code prepends an Anthropic-only billing attribution block whose
  // `cch` value changes every request. It is envelope metadata, not a model
  // instruction, and forwarding it to OpenAI would invalidate the stable
  // prompt prefix. Anthropic passthrough and non-OAuth providers are untouched.
  const baseSystem = systemToString(body.system, options?.openAiOAuth === true);
  // Claude can add and remove inline system reminders while MCP servers start.
  // The Codex Responses API accepts fresh instructions on every request, so
  // keep these current instructions out of replayed conversation history. This
  // lets a durable native-compaction checkpoint survive a daemon restart while
  // the MCP tool set is still settling. Other providers retain positional
  // system messages because their semantics can differ.
  const inlineSystem = options?.openAiOAuth ? inlineSystemToString(messages) : undefined;
  const systemText = options?.openAiOAuth
    ? joinInstructions(
        baseSystem ?? 'You are a coding assistant.',
        OPENAI_OAUTH_STEERING_POLICY,
        inlineSystem,
      )
    : joinInstructions(baseSystem, inlineSystem);
  const conversationMessages = options?.openAiOAuth
    ? messages.filter(message => message.role !== 'system')
    : messages;

  // resolveUpstreamTools uses the shared proxy types; the adapter keeps its own
  // minimal request shapes, so cast at this boundary. Keep compact-request tool
  // definitions intact for prompt-cache prefix reuse; toolChoice='none' below
  // makes them unavailable at the provider API rather than by prompt compliance.
  const compactRequest = isClaudeCodeCompactRequest(body);
  let upstreamTools = resolveUpstreamTools(
    body.tools,
    messages as unknown as AnthropicRequestMessage[],
  ) as unknown as AnthropicTool[];
  if (options?.maxTools !== undefined && upstreamTools.length > options.maxTools) {
    upstreamTools = upstreamTools.slice(0, options.maxTools);
  }
  const configuredEffort = anthropicEffortFromRequest(body) ?? options?.defaultEffort;
  // Keep Claude's compact request in the active session effort partition.
  // The Responses transport needs the matching warm previous_response_id head
  // to invoke native in-band compaction; forcing low here makes a medium/high
  // session look unrelated and falls back to retransmitting full history.
  const effort = configuredEffort;
  let providerOptions = deepMergeProviderOptions(
    thinkingProviderOptions(npm),
    effortProviderOptions(npm, effort, options?.reasoningMetadata?.upstreamModelId ?? body.model, options?.reasoningMetadata),
  );

  // ChatGPT Codex OAuth backend requires `instructions` in providerOptions and
  // rejects the standard `system` field. It also manages its own output limit.
  if (options?.openAiOAuth && systemText) {
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: {
        instructions: systemText,
        // The pinned AI SDK serializes the established `priority` value. OpenAI
        // documents `fast` and `priority` as equivalent for supported models.
        ...(options.processingMode === 'fast' ? { serviceTier: 'priority' } : {}),
      },
    });
  }

  const upstreamModelId = options?.reasoningMetadata?.upstreamModelId ?? body.model;
  const supportsExplicitOpenAiCaching = !options?.openAiOAuth
    && supportsOpenAiPromptCacheBreakpoints(upstreamModelId);

  // Keep related requests in one cache partition. Prefer Claude Code's stable
  // session identity when available; the system/tools hash remains the fallback
  // for other Anthropic clients and API-server callers.
  //
  // GPT-5.6+ public-API implicit mode also
  // honors the explicit breakpoints copied from Claude Code's cache_control
  // blocks, while retaining an automatic latest-message breakpoint as fallback.
  if (npm === '@ai-sdk/openai') {
    const claudeSessionId = extractClaudeSessionId(body, options?.claudeSessionId);
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: {
        promptCacheKey: claudeSessionId
          ? claudeSessionPromptCacheKey(claudeSessionId)
          : openAiPromptCacheKey(baseSystem, upstreamTools),
        ...(supportsExplicitOpenAiCaching
          ? { promptCacheOptions: { mode: 'implicit', ttl: '30m' } }
          : {}),
      },
    });
  }

  return {
    instructions: options?.openAiOAuth || supportsExplicitOpenAiCaching ? undefined : systemText,
    messages: [
      ...(supportsExplicitOpenAiCaching ? translateTopLevelSystemForOpenAi(body.system) : []),
      ...translateMessages(
        conversationMessages,
        npm,
        supportsExplicitOpenAiCaching,
        options?.openAiOAuth === true,
      ),
    ],
    allowSystemInMessages: true,
    tools: translateTools(upstreamTools.length ? upstreamTools : undefined, npm),
    toolChoice: compactRequest ? 'none' : translateToolChoice(body.tool_choice),
    maxOutputTokens: options?.openAiOAuth ? undefined : body.max_tokens,
    temperature: body.temperature,
    providerOptions,
  };
}

// ── usage: SDK → Anthropic ────────────────────────────────────────────────────
interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  /** AI SDK 6 compatibility for older third-party LanguageModel implementations. */
  cachedInputTokens?: number;
}
interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  service_tier?: 'standard' | 'priority' | 'batch';
  speed?: 'standard' | 'fast';
}

function openAiServiceTier(providerMetadata: unknown): string | undefined {
  if (!providerMetadata || typeof providerMetadata !== 'object') return undefined;
  const openai = (providerMetadata as Record<string, unknown>)['openai'];
  if (!openai || typeof openai !== 'object') return undefined;
  const serviceTier = (openai as Record<string, unknown>)['serviceTier'];
  return typeof serviceTier === 'string' ? serviceTier : undefined;
}

function applyOpenAiServiceTier(
  usage: AnthropicUsage,
  providerMetadata: unknown,
): AnthropicUsage {
  const serviceTier = openAiServiceTier(providerMetadata);
  if (!serviceTier) return usage;
  if (serviceTier === 'priority' || serviceTier === 'fast') {
    return { ...usage, service_tier: 'priority', speed: 'fast' };
  }
  if (serviceTier === 'batch') {
    return { ...usage, service_tier: 'batch', speed: 'standard' };
  }
  return { ...usage, service_tier: 'standard', speed: 'standard' };
}

/**
 * Map SDK usage → Anthropic usage. SDK providers report the cache-hit subset in
 * `inputTokenDetails`, counted WITHIN the prompt total. The Anthropic schema
 * expects cache reads and writes in separate fields, so subtract both subsets
 * from input_tokens to avoid double-counting. GPT-5.6+ reports cache writes;
 * older models generally report reads only.
 */
function toAnthropicUsage(u?: SdkUsage): AnthropicUsage {
  const total = u?.inputTokens ?? 0;
  const cacheRead = u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens ?? 0;
  const cacheWrite = u?.inputTokenDetails?.cacheWriteTokens ?? 0;
  return {
    input_tokens: Math.max(0, total - cacheRead - cacheWrite),
    output_tokens: u?.outputTokens ?? 0,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
}

// ── response: SDK fullStream → Anthropic SSE ─────────────────────────────────
type WriteFn = (chunk: string) => void;

type LogFn = (msg: () => string) => void;

export interface AnthropicStreamObserver {
  /** Called for every AI SDK fullStream part before Relay translates it. */
  onPart?: (partType: string) => void;
  /** Final Anthropic-shaped usage emitted in message_delta. */
  onUsage?: (usage: AnthropicUsage) => void;
  /** Local fallback used when the provider omits usage at stream completion. */
  initialInputTokens?: number;
  abortSignal?: AbortSignal;
  /** Abort if the provider produces no stream event for this long. */
  idleTimeoutMs?: number;
}

const SDK_STREAM_IDLE_TIMEOUT_MS = MODEL_STREAM_IDLE_TIMEOUT_MS;
const SDK_TOTAL_TIMEOUT_MS = MODEL_TOTAL_TIMEOUT_MS;

function streamAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal?.reason === 'string' ? signal.reason : 'SDK stream aborted',
  );
  error.name = 'AbortError';
  return error;
}

/**
 * Forward caller cancellation into a Relay-owned controller without creating
 * an AbortSignal.any() composite. Some runtimes retain source-aborted
 * composites while listeners remain.
 */
function forwardAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const forward = () => {
    if (!target.signal.aborted) target.abort(source.reason);
  };
  if (source.aborted) {
    forward();
    return () => {};
  }
  source.addEventListener('abort', forward, { once: true });
  return () => source.removeEventListener('abort', forward);
}

export async function writeAnthropicStream(
  stream: AsyncIterable<FullStreamPart>,
  modelId: string,
  write: WriteFn,
  log?: LogFn,
  observer?: AnthropicStreamObserver,
  tools?: SdkCallParams['tools'],
): Promise<void> {
  const messageId = 'msg_' + Date.now();
  const requiredProps = toolRequiredProps(tools);
  let blockIndex = -1;
  let started = false;
  let openType: 'text' | 'thinking' | 'tool' | 'server-tool' | 'server-tool-result' | null = null;
  let pendingThinkingSig: string | undefined;
  const idToBlock = new Map<string, number>();
  // Tool input deltas are buffered (not forwarded raw) so the complete input
  // can be sanitized once the SDK's parsed `tool-call` part arrives.
  const toolJsonBuffer = new Map<string, string>();
  const flushedTools = new Set<string>();
  let openToolId: string | null = null;
  let finishReason = 'end_turn';
  let usage: AnthropicUsage = {
    input_tokens: observer?.initialInputTokens ?? 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  const emit = (event: string, data: unknown) => write(sseChunk(event, data));
  const ensureStart = () => {
    if (started) return;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', content: [],
        model: modelId, stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    started = true;
  };
  const closeOpen = () => {
    if (openType === 'thinking') {
      emit('content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'signature_delta', signature: pendingThinkingSig ?? '' },
      });
      pendingThinkingSig = undefined;
    }
    // Stream ended (or moved on) without a tool-call part for this block: emit
    // the buffered raw JSON so the deltas that did arrive are not lost.
    if (openType === 'tool' && openToolId !== null && !flushedTools.has(openToolId)) {
      const buffered = toolJsonBuffer.get(openToolId);
      if (buffered) {
        emit('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: buffered },
        });
      }
      flushedTools.add(openToolId);
    }
    if (openType) emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openType = null;
    openToolId = null;
  };
  const openBlock = (
    type: 'text' | 'thinking' | 'tool' | 'server-tool' | 'server-tool-result',
    contentBlock: unknown,
  ) => {
    ensureStart(); closeOpen(); blockIndex++; openType = type;
    emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: contentBlock });
  };
  const ensureOpenBlock = (type: 'text' | 'thinking', contentBlock: unknown) => {
    if (openType === type) return;
    openBlock(type, contentBlock);
  };
  // Read through a function because stream callbacks mutate this state between
  // iterations; TypeScript's local narrowing cannot model that mutation.
  const currentOpenType = () => openType;
  const providerWebSearchIds = new Set<string>();
  const isProviderWebSearch = (part: FullStreamPart): boolean =>
    part.toolName === 'web_search' && part.providerExecuted === true;
  const serverToolUseId = (id: string): string =>
    id.startsWith('srvtoolu_') ? id : `srvtoolu_${id}`;
  const handleWebSearchResult = (part: FullStreamPart): void => {
    const toolCallId = part.toolCallId ?? '';
    const output = part.output as {
      action?: {
        type?: string;
        query?: string;
        queries?: string[];
        url?: string | null;
        pattern?: string | null;
      };
      sources?: Array<{ type?: string; url?: string; name?: string }>;
    } | undefined;
    const action = output?.action;
    const query = action?.query
      ?? action?.queries?.join(' OR ')
      ?? action?.url
      ?? action?.pattern
      ?? '';
    const id = serverToolUseId(toolCallId);
    openBlock('server-tool', {
      type: 'server_tool_use', id, name: 'web_search', input: {},
    });
    emit('content_block_delta', {
      type: 'content_block_delta', index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
    });
    closeOpen();
    openBlock('server-tool-result', {
      type: 'web_search_tool_result',
      tool_use_id: id,
      content: (output?.sources ?? [])
        .filter(source => source.type === 'url' && typeof source.url === 'string')
        .map(source => ({
          type: 'web_search_result',
          url: source.url,
          title: source.url,
          encrypted_content: '',
          page_age: null,
        })),
    });
    closeOpen();
  };
  const handleToolCall = (part: FullStreamPart): void => {
    const id = part.toolCallId ?? '';
    const required = requiredProps.get(part.toolName ?? '');
    if (idToBlock.has(id)) {
      if (flushedTools.has(id)) return;
      const json = part.input !== undefined && part.input !== null
        ? JSON.stringify(sanitizeToolInput(part.input as Record<string, unknown>, required))
        : (toolJsonBuffer.get(id) ?? '');
      if (json) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: idToBlock.get(id) ?? blockIndex,
          delta: { type: 'input_json_delta', partial_json: json },
        });
      }
      flushedTools.add(id);
      return;
    }
    if (currentOpenType() === 'tool') return;
    const sig = grabRoundTripSignature(part);
    openBlock('tool', {
      type: 'tool_use',
      id: encodeToolUseId(id, sig),
      name: part.toolName,
      input: {},
    });
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(
          sanitizeToolInput(part.input as Record<string, unknown>, required),
        ),
      },
    });
    flushedTools.add(id);
  };

  for await (const part of stream) {
    observer?.onPart?.(part.type);
    if (observer?.abortSignal?.aborted) throw streamAbortError(observer.abortSignal);
    switch (part.type) {
      // The SDK emits start before it knows whether the provider accepted the
      // request. Wait for content/finish so a pre-content HTTP failure can still
      // propagate through the proxy with its real non-2xx status.
      case 'start': break;

      // An abort is terminal but is not an error part in the AI SDK stream. If
      // treated like an unknown part, the loop ends and Relay synthesizes a
      // message_start/message_delta/message_stop after the client disconnected.
      // Throw so the HTTP layer follows its cancellation path and emits nothing.
      case 'abort':
        throw streamAbortError(observer?.abortSignal);

      case 'reasoning-start':
        openBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
        break;
      case 'reasoning-delta':
        ensureOpenBlock('thinking', { type: 'thinking', thinking: '', signature: '' });
        emit('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'thinking_delta', thinking: part.text ?? '' },
        });
        break;
      case 'reasoning-end': {
        const sig = grabRoundTripSignature(part);
        if (sig) pendingThinkingSig = sig;
        break;
      }

      case 'text-start':
        openBlock('text', { type: 'text', text: '' });
        break;
      case 'text-delta':
        ensureOpenBlock('text', { type: 'text', text: '' });
        emit('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'text_delta', text: part.text ?? '' },
        });
        break;
      case 'text-end': break;

      case 'tool-input-start': {
        if (isProviderWebSearch(part)) {
          providerWebSearchIds.add(part.id ?? '');
          break;
        }
        const sig = grabRoundTripSignature(part);
        openBlock('tool', {
          type: 'tool_use', id: encodeToolUseId(part.id ?? '', sig), name: part.toolName, input: {},
        });
        idToBlock.set(part.id ?? '', blockIndex);
        openToolId = part.id ?? '';
        break;
      }
      case 'tool-input-delta': {
        const id = part.id ?? '';
        if (providerWebSearchIds.has(id)) break;
        toolJsonBuffer.set(id, (toolJsonBuffer.get(id) ?? '') + (part.delta ?? part.text ?? ''));
        break;
      }
      case 'tool-input-end': break;

      case 'tool-call': {
        if (isProviderWebSearch(part)) {
          providerWebSearchIds.add(part.toolCallId ?? '');
          break;
        }
        finishReason = 'tool_use';
        handleToolCall(part);
        break;
      }

      case 'tool-result':
        if (isProviderWebSearch(part)) handleWebSearchResult(part);
        break;

      case 'finish':
        if (part.totalUsage) {
          const finalUsage = toAnthropicUsage(part.totalUsage);
          const hasFinalInputUsage = finalUsage.input_tokens
            + finalUsage.cache_creation_input_tokens
            + finalUsage.cache_read_input_tokens > 0;
          usage = hasFinalInputUsage
            ? finalUsage
            : { ...usage, output_tokens: finalUsage.output_tokens };
        }
        usage = applyOpenAiServiceTier(usage, part.providerMetadata);
        if (part.finishReason === 'tool-calls') finishReason = 'tool_use';
        else if (part.finishReason === 'length') finishReason = 'max_tokens';
        else if (part.finishReason === 'stop' && finishReason !== 'tool_use') finishReason = 'end_turn';
        break;

      case 'error': {
        const e = part.error as { data?: unknown; message?: string } | undefined;
        const errMsg = e?.message || (typeof part.error === 'string' ? part.error : JSON.stringify(e?.data ?? part.error));
        const errorType = anthropicErrorType(upstreamHttpStatus(part.error, errMsg));
        log?.(() => `sdk stream error (${errorType}): ${errMsg}`);
        closeOpen();
        throw part.error instanceof Error || (part.error && typeof part.error === 'object')
          ? part.error
          : new Error(errMsg);
      }

      default: break;
    }
  }

  // Some SDK transports end the iterator without yielding an explicit abort
  // part. Never synthesize completion frames for an already-cancelled request.
  if (observer?.abortSignal?.aborted) throw streamAbortError(observer.abortSignal);

  closeOpen();
  ensureStart();
  observer?.onUsage?.(usage);
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: null }, usage });
  emit('message_stop', { type: 'message_stop' });
}

// ── high-level entry points ──────────────────────────────────────────────────
export async function streamAnthropicResponse(
  model: LanguageModel,
  params: SdkCallParams,
  modelId: string,
  write: WriteFn,
  log?: LogFn,
  observer?: AnthropicStreamObserver,
  dependencies: { streamText?: typeof streamText } = {},
): Promise<void> {
  const idleTimeoutMs = observer?.idleTimeoutMs ?? SDK_STREAM_IDLE_TIMEOUT_MS;
  const idleAbort = new AbortController();
  const stopForwardingAbort = forwardAbortSignal(observer?.abortSignal, idleAbort);
  const abortSignal = idleAbort.signal;
  let idleTimer = setTimeout(
    () => idleAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
    idleTimeoutMs,
  );
  const totalTimer = setTimeout(
    () => idleAbort.abort(new Error(`provider stream exceeded ${Math.round(SDK_TOTAL_TIMEOUT_MS / 1000)}s`)),
    SDK_TOTAL_TIMEOUT_MS,
  );
  // Do not combine streamText's total/chunk timeout signals here. In AI SDK
  // 7.0.22 that composition retains completed StreamTextResult graphs. Relay
  // owns the timers and explicitly settles its controller after consumption.
  const providerStream = (dependencies.streamText ?? streamText)({
    model,
    ...params,
    abortSignal,
    onError: () => {},
  } as Parameters<typeof streamText>[0]).stream as AsyncIterable<FullStreamPart>;

  const watchedStream = (async function* () {
    try {
      for await (const part of providerStream) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => idleAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
          idleTimeoutMs,
        );
        yield part;
      }
    } finally {
      clearTimeout(idleTimer);
    }
  })();

  try {
    await writeAnthropicStream(watchedStream, modelId, write, log, { ...observer, abortSignal }, params.tools);
  } finally {
    stopForwardingAbort();
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    // Settle the direct Relay-owned signal only after stream consumption. Do not
    // replace this with AbortSignal.any(): source-driven abort can retain the
    // dependent composite after the request has completed.
    if (!idleAbort.signal.aborted) idleAbort.abort();
  }
}

export async function generateAnthropicResponse(
  model: LanguageModel,
  params: SdkCallParams,
  modelId: string,
  options?: {
    forceStream?: boolean;
    abortSignal?: AbortSignal;
    onPart?: (partType: string) => void;
    idleTimeoutMs?: number;
    streamText?: typeof streamText;
    generateText?: typeof generateText;
  },
): Promise<Record<string, unknown>> {
  let text: string;
  let toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  let finishReason: string;
  let usage: SdkUsage | undefined;
  let providerMetadata: unknown;

  if (options?.forceStream) {
    // Some upstreams (e.g. ChatGPT's Codex backend) reject non-streaming requests
    // outright. Request a real stream from the SDK and collect it into one
    // response instead of forwarding the client's non-streaming request upstream.
    const forceAbort = new AbortController();
    const stopForwardingAbort = forwardAbortSignal(options.abortSignal, forceAbort);
    const abortSignal = forceAbort.signal;
    const idleTimeoutMs = options.idleTimeoutMs ?? SDK_STREAM_IDLE_TIMEOUT_MS;
    let idleTimer = setTimeout(
      () => forceAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
      idleTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => forceAbort.abort(new Error(`provider stream exceeded ${Math.round(SDK_TOTAL_TIMEOUT_MS / 1000)}s`)),
      SDK_TOTAL_TIMEOUT_MS,
    );
    // See the streaming path above: Relay owns these timers and explicitly
    // settles its controller when the stream has been fully reduced.
    const r = (options.streamText ?? streamText)({
      model,
      ...params,
      abortSignal,
      onError: () => {},
    } as Parameters<typeof streamText>[0]);
    const streamedText: string[] = [];
    const streamedToolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
    let streamedFinishReason = 'stop';
    let streamedUsage: SdkUsage | undefined;
    try {
      for await (const part of r.stream as AsyncIterable<FullStreamPart>) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => forceAbort.abort(new Error(`no data received from provider for ${Math.round(idleTimeoutMs / 1000)}s`)),
          idleTimeoutMs,
        );
        options.onPart?.(part.type);
        if (abortSignal.aborted || part.type === 'abort') {
          throw streamAbortError(abortSignal);
        }
        if (part.type === 'error') {
          throw part.error instanceof Error || (part.error && typeof part.error === 'object')
            ? part.error
            : new Error(typeof part.error === 'string' ? part.error : 'Upstream stream failed');
        }
        if (part.type === 'text-delta') streamedText.push(part.text ?? '');
        else if (part.type === 'tool-call') {
          streamedToolCalls.push({
            toolCallId: part.toolCallId ?? '',
            toolName: part.toolName ?? '',
            input: part.input,
          });
        } else if (part.type === 'finish') {
          streamedFinishReason = part.finishReason ?? streamedFinishReason;
          streamedUsage = part.totalUsage;
          providerMetadata = part.providerMetadata;
        }
      }
      if (abortSignal.aborted) throw streamAbortError(abortSignal);
    } finally {
      stopForwardingAbort();
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      // See the streaming path above: settle the Relay-owned signal after the
      // result is fully reduced so Node can release AI SDK's listener graph.
      if (!forceAbort.signal.aborted) forceAbort.abort();
    }
    text = streamedText.join('');
    toolCalls = streamedToolCalls;
    finishReason = streamedFinishReason;
    usage = streamedUsage;
  } else {
    const generateAbort = new AbortController();
    const stopForwardingAbort = forwardAbortSignal(options?.abortSignal, generateAbort);
    const totalTimer = setTimeout(
      () => generateAbort.abort(new Error(`provider request exceeded ${Math.round(SDK_TOTAL_TIMEOUT_MS / 1000)}s`)),
      SDK_TOTAL_TIMEOUT_MS,
    );
    try {
    const r = await (options?.generateText ?? generateText)({
        model,
        ...params,
        abortSignal: generateAbort.signal,
      } as Parameters<typeof generateText>[0]);
      ({ text, toolCalls, finishReason, usage, providerMetadata } = r);
    } finally {
      stopForwardingAbort();
      clearTimeout(totalTimer);
      if (!generateAbort.signal.aborted) generateAbort.abort();
    }
  }

  const requiredProps = toolRequiredProps(params.tools);
  return {
    id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model: modelId,
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map(tc => ({
        type: 'tool_use',
        id: encodeToolUseId(tc.toolCallId, grabRoundTripSignature(tc as FullStreamPart)),
        name: tc.toolName,
        input: sanitizeToolInput(tc.input as Record<string, unknown>, requiredProps.get(tc.toolName)),
      })),
    ],
    stop_reason: finishReason === 'tool-calls' ? 'tool_use' : 'end_turn',
    usage: applyOpenAiServiceTier(toAnthropicUsage(usage), providerMetadata),
  };
}
