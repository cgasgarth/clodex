import { createHash } from 'node:crypto';
import { IMAGE_INPUT_TOKEN_ESTIMATE } from '../../anthropic-endpoints.js';
import { RESPONSES_COMPACTION_RETAINED_USER_TOKENS } from './types.js';
import type { JsonObject, ConnectionEntry } from './types.js';
import { canonicalJson, inputArray } from './fingerprint.js';

function normalizeToolCallJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeToolCallJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as JsonObject;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(record)) out[key] = normalizeToolCallJson(child);

  // Claude parses tool_use input into an object. The OpenAI SDK later serializes
  // it again, so insignificant whitespace and object-key order can differ from
  // the model's original function-call argument string. Compare the JSON value,
  // while leaving message text and function_call_output strings exact.
  const jsonField = record.type === 'function_call'
    ? 'arguments'
    : record.type === 'custom_tool_call' ? 'input' : undefined;
  if (jsonField && typeof record[jsonField] === 'string') {
    try {
      out[jsonField] = canonicalJson(JSON.parse(record[jsonField]));
    } catch {
      // A malformed/non-JSON custom-tool input must still match byte-for-byte.
    }
  }
  return out;
}

export type ContinuationMatchMode =
  | 'exact'
  | 'replayed_reasoning'
  | 'omitted_reasoning'
  | 'claude_compaction_summary'
  | 'claude_compaction_request';

export function continuationMatchRank(mode: ContinuationMatchMode): number {
  switch (mode) {
    case 'exact': return 0;
    case 'replayed_reasoning': return 1;
    case 'omitted_reasoning': return 2;
    case 'claude_compaction_summary': return 3;
    case 'claude_compaction_request': return 4;
  }
}

export interface ContinuationMatch {
  delta: unknown[];
  mode: ContinuationMatchMode;
}

export interface ContinuationSource {
  requestInput?: unknown[];
  expectedAssistant?: unknown[];
  requestInputHashes?: string[];
  requestInputKinds?: string[];
  expectedAssistantHashes?: string[];
  expectedAssistantKinds?: string[];
  claudeCompactionSummaryHash?: string;
}

export interface PreparedConversationItems {
  items: unknown[];
  hashes: string[];
}

const CLAUDE_COMPACTION_CONTINUATION_PREFIX =
  'This session is being continued from a previous conversation that ran out of context. '
  + 'The summary below covers the earlier portion of the conversation.\n\n';
const CLAUDE_COMPACTION_CONTINUATION_SUFFIX =
  'Continue the conversation from where it left off without asking the user any further questions. '
  + 'Resume directly — do not acknowledge the summary, do not recap what was happening, '
  + 'do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
const CLAUDE_COMPACTION_SUMMARY_TRAILERS = [
  '\n\nIf you need specific details from before compaction',
  '\n\nRecent messages are preserved verbatim.',
  '\n\nYour REPL VM state has been cleared as part of this compaction.',
  `\n${CLAUDE_COMPACTION_CONTINUATION_SUFFIX}`,
] as const;
const MIN_CLAUDE_COMPACTION_SUMMARY_CHARACTERS = 32;

export function conversationItemKind(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value;
  const record = value as JsonObject;
  if (typeof record.type === 'string') return record.type;
  if (typeof record.role === 'string') return record.role;
  return 'object';
}

export function isOpaqueCompactionKind(kind: string): boolean {
  return kind === 'compaction' || kind === 'compaction_summary';
}

function approximateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function retainedContentPartTokens(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const record = value as JsonObject;
  if (typeof record.text === 'string') return approximateTextTokens(record.text);
  return record.type === 'input_image' || record.type === 'input_audio'
    ? IMAGE_INPUT_TOKEN_ESTIMATE
    : 0;
}

function approximateRetainedMessageTokens(value: unknown): number {
  if (!value || typeof value !== 'object') return 1;
  const content = (value as JsonObject).content;
  if (!Array.isArray(content)) return 1;
  return Math.max(1, content.reduce(
    (tokens, part) => tokens + retainedContentPartTokens(part),
    0,
  ));
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    let previous = start - 1;
    const code = text.charCodeAt(previous);
    if (code >= 0xDC00 && code <= 0xDFFF && previous > 0) previous -= 1;
    const character = text.slice(previous, start);
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    start = previous;
  }
  return text.slice(start);
}

function truncateRetainedText(text: string, maxTokens: number): string {
  const maxBytes = Math.max(0, maxTokens) * 4;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const marker = '\n…[retained text truncated]…\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes) return utf8Prefix(text, maxBytes);
  const bodyBytes = maxBytes - markerBytes;
  const head = utf8Prefix(text, Math.ceil(bodyBytes / 2));
  const tail = utf8Suffix(text, Math.floor(bodyBytes / 2));
  return `${head}${marker}${tail}`;
}

function truncateRetainedUserMessage(value: unknown, maxTokens: number): unknown {
  if (!value || typeof value !== 'object' || maxTokens <= 0) return undefined;
  const record = value as JsonObject;
  if (record.role !== 'user' || !Array.isArray(record.content)) return undefined;
  let remainingTokens = maxTokens;
  const content = record.content.flatMap(part => {
    if (!part || typeof part !== 'object') return [];
    const partRecord = part as JsonObject;
    if (typeof partRecord.text !== 'string') {
      const partTokens = retainedContentPartTokens(part);
      if (partTokens > remainingTokens) return [];
      remainingTokens -= partTokens;
      return [part];
    }
    if (remainingTokens <= 0) return [];
    const text = partRecord.text;
    const partTokens = retainedContentPartTokens(part);
    if (partTokens <= remainingTokens) {
      remainingTokens -= partTokens;
      return [part];
    }
    const truncatedText = truncateRetainedText(text, remainingTokens);
    remainingTokens = 0;
    return truncatedText ? [{ ...partRecord, text: truncatedText }] : [];
  });
  return content.length ? { ...record, content } : undefined;
}

/**
 * Match Codex remote-compaction v2's retained-history policy: recent user
 * messages only, bounded to 64K approximate tokens, followed by the opaque
 * native compaction item.
 */
export function retainedUserMessages(input: unknown[]): unknown[] {
  let remaining = RESPONSES_COMPACTION_RETAINED_USER_TOKENS;
  const retainedReversed: unknown[] = [];
  for (const item of [...input].reverse()) {
    if (!item || typeof item !== 'object' || (item as JsonObject).role !== 'user') continue;
    const itemTokens = approximateRetainedMessageTokens(item);
    if (itemTokens <= remaining) {
      retainedReversed.push(item);
      remaining -= itemTokens;
      continue;
    }
    const truncated = truncateRetainedUserMessage(item, remaining);
    if (truncated) retainedReversed.push(truncated);
    remaining = 0;
    break;
  }
  retainedReversed.reverse();
  return retainedReversed;
}

/**
 * Mirror Claude Code's current compaction-output normalization: discard its
 * analysis wrapper, unwrap <summary>, collapse excessive blank lines, and trim.
 * Only a hash of this portable summary is retained.
 */
function normalizeClaudeCompactionSummary(text: string): string {
  let normalized = text.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const summary = normalized.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summary) {
    normalized = normalized.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${(summary[1] ?? '').trim()}`,
    );
  }
  return normalized.replace(/\n\n+/g, '\n\n').trim();
}

export function compactionSummaryHash(text: string): string | undefined {
  const normalized = normalizeClaudeCompactionSummary(text);
  if (normalized.length < MIN_CLAUDE_COMPACTION_SUMMARY_CHARACTERS) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}

export function assistantCompactionSummaryText(items: unknown[]): string {
  let selected = '';
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as JsonObject;
    if (record.role !== 'assistant' || !Array.isArray(record.content)) continue;
    const textParts = record.content.flatMap(part => (
      part
      && typeof part === 'object'
      && typeof (part as JsonObject).text === 'string'
        ? [(part as JsonObject).text as string]
        : []
    ));
    if (textParts.some(text => text.includes('<summary>'))) {
      selected = textParts[0] ?? '';
    }
  }
  return selected;
}

interface ClaudeCompactionEnvelope {
  summaryHash: string;
  trailingText?: string;
}

export function claudeCompactionEnvelopeOccurrenceCount(payload: JsonObject): number {
  let count = 0;
  for (const item of inputArray(payload)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as JsonObject;
    if (record.role !== 'user' || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as JsonObject).text;
      if (typeof text !== 'string') continue;
      let offset = 0;
      while (true) {
        const index = text.indexOf(CLAUDE_COMPACTION_CONTINUATION_PREFIX, offset);
        if (index === -1) break;
        count += 1;
        offset = index + CLAUDE_COMPACTION_CONTINUATION_PREFIX.length;
      }
    }
  }
  return count;
}

function parseClaudeCompactionEnvelope(text: string): ClaudeCompactionEnvelope | undefined {
  const prefixIndex = text.indexOf(CLAUDE_COMPACTION_CONTINUATION_PREFIX);
  if (prefixIndex === -1) return undefined;
  if (text.indexOf(
    CLAUDE_COMPACTION_CONTINUATION_PREFIX,
    prefixIndex + CLAUDE_COMPACTION_CONTINUATION_PREFIX.length,
  ) !== -1) {
    return undefined;
  }
  const body = text.slice(prefixIndex + CLAUDE_COMPACTION_CONTINUATION_PREFIX.length);
  let summaryEnd = body.length;
  for (const marker of CLAUDE_COMPACTION_SUMMARY_TRAILERS) {
    const markerIndex = body.indexOf(marker);
    if (markerIndex !== -1) summaryEnd = Math.min(summaryEnd, markerIndex);
  }
  const summaryHash = compactionSummaryHash(body.slice(0, summaryEnd));
  if (!summaryHash) return undefined;

  const suffixIndex = body.indexOf(`\n${CLAUDE_COMPACTION_CONTINUATION_SUFFIX}`);
  const trailingText = suffixIndex === -1
    ? undefined
    : body.slice(suffixIndex + CLAUDE_COMPACTION_CONTINUATION_SUFFIX.length + 1).trim();
  return { summaryHash, ...(trailingText ? { trailingText } : {}) };
}

/**
 * Claude Code replaces its local transcript with a wrapped portable summary
 * after reactive compaction. Re-anchor that rewritten lineage to the opaque
 * native state only when the exact summary hash matches.
 */
function claudeCompactionContinuationMatch(
  entry: ContinuationSource,
  payload: JsonObject,
): ContinuationMatch | undefined {
  if (!entry.claudeCompactionSummaryHash) return undefined;
  if (claudeCompactionEnvelopeOccurrenceCount(payload) !== 1) return undefined;
  const full = inputArray(payload);
  for (let itemIndex = 0; itemIndex < full.length; itemIndex += 1) {
    const item = full[itemIndex];
    if (!item || typeof item !== 'object') continue;
    const record = item as JsonObject;
    if (record.role !== 'user' || !Array.isArray(record.content)) continue;
    for (let partIndex = 0; partIndex < record.content.length; partIndex += 1) {
      const part = record.content[partIndex];
      if (!part || typeof part !== 'object') continue;
      const partRecord = part as JsonObject;
      if (typeof partRecord.text !== 'string') continue;
      const envelope = parseClaudeCompactionEnvelope(partRecord.text);
      if (!envelope || envelope.summaryHash !== entry.claudeCompactionSummaryHash) continue;

      const remainingContent = [
        ...(envelope.trailingText
          ? [{ ...partRecord, text: envelope.trailingText }]
          : []),
        ...record.content.slice(partIndex + 1),
      ];
      const delta = [
        ...(remainingContent.length ? [{ ...record, content: remainingContent }] : []),
        ...full.slice(itemIndex + 1),
      ];
      return delta.length
        ? { delta, mode: 'claude_compaction_summary' }
        : undefined;
    }
  }
  return undefined;
}

export function conversationItemHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(normalizeToolCallJson(value))).digest('hex').slice(0, 16);
}

/** Canonicalize the incoming conversation once, then reuse it for every head. */
export function prepareConversationItems(payload: JsonObject): PreparedConversationItems {
  const items = inputArray(payload);
  return { items, hashes: items.map(conversationItemHash) };
}

export function continuationMismatchDetails(
  entry: ConnectionEntry,
  payload: JsonObject,
  prepared = prepareConversationItems(payload),
): Record<string, unknown> {
  const full = prepared.items;
  const prefix = [...(entry.requestInput ?? []), ...(entry.expectedAssistant ?? [])];
  const prefixHashes = [
    ...(entry.requestInputHashes ?? entry.requestInput?.map(conversationItemHash) ?? []),
    ...(entry.expectedAssistantHashes ?? entry.expectedAssistant?.map(conversationItemHash) ?? []),
  ];
  const comparable = Math.min(full.length, prefix.length);
  let mismatch = comparable;
  for (let index = 0; index < comparable; index += 1) {
    if (prepared.hashes[index] !== prefixHashes[index]) {
      mismatch = index;
      break;
    }
  }
  const expected = mismatch < prefix.length ? prefix[mismatch] : undefined;
  const actual = mismatch < full.length ? full[mismatch] : undefined;
  return {
    fullItems: full.length,
    expectedPrefixItems: prefix.length,
    firstMismatch: mismatch,
    expectedKind: expected === undefined ? 'none' : conversationItemKind(expected),
    actualKind: actual === undefined ? 'none' : conversationItemKind(actual),
    ...(expected !== undefined ? { expectedHash: prefixHashes[mismatch] } : {}),
    ...(actual !== undefined ? { actualHash: prepared.hashes[mismatch] } : {}),
  };
}

export function continuationMismatchSummary(entry: ConnectionEntry, payload: JsonObject): string {
  const details = continuationMismatchDetails(entry, payload);
  return `full_items=${details.fullItems} expected_prefix_items=${details.expectedPrefixItems} `
    + `first_mismatch=${details.firstMismatch} expected=${details.expectedKind} actual=${details.actualKind}`;
}

export function historyContinuationMatch(
  entry: ContinuationSource,
  payload: JsonObject,
  prepared = prepareConversationItems(payload),
): ContinuationMatch | undefined {
  const requestHashes = entry.requestInputHashes
    ?? entry.requestInput?.map(conversationItemHash);
  const requestKinds = entry.requestInputKinds
    ?? entry.requestInput?.map(conversationItemKind);
  const assistantHashes = entry.expectedAssistantHashes
    ?? entry.expectedAssistant?.map(conversationItemHash);
  const assistantKinds = entry.expectedAssistantKinds
    ?? entry.expectedAssistant?.map(conversationItemKind);
  if (!requestHashes || !requestKinds || !assistantHashes || !assistantKinds) return undefined;
  const full = prepared.items;
  const fullHashes = prepared.hashes;
  const exactPrefixHashes = [...requestHashes, ...assistantHashes];
  if (
    full.length > exactPrefixHashes.length
    && fullHashes.slice(0, exactPrefixHashes.length)
      .every((hash, index) => hash === exactPrefixHashes[index])
  ) {
    return { delta: full.slice(exactPrefixHashes.length), mode: 'exact' };
  }

  // Claude reserializes opaque OpenAI reasoning while it rebuilds Anthropic
  // request history. That can change ids, encrypted payloads, and summaries at
  // any earlier turn, not only in the latest assistant response. Match the
  // complete visible history exactly, but permit reasoning envelopes to be
  // reshaped, repeated, or omitted. Item order and every user message, tool
  // call, tool result, and visible assistant message remain strict boundaries.
  const expectedKinds = [...requestKinds, ...assistantKinds];
  let expectedIndex = 0;
  let fullIndex = 0;
  let replayedReasoning = false;
  let omittedReasoning = false;
  while (expectedIndex < exactPrefixHashes.length) {
    const expectedKind = expectedKinds[expectedIndex];
    if (expectedKind === 'reasoning' || isOpaqueCompactionKind(expectedKind ?? '')) {
      const start = fullIndex;
      while (
        fullIndex < full.length
        && conversationItemKind(full[fullIndex]) === 'reasoning'
      ) fullIndex += 1;
      replayedReasoning ||= fullIndex > start;
      omittedReasoning ||= fullIndex === start;
      expectedIndex += 1;
      continue;
    }
    while (
      fullIndex < full.length
      && conversationItemKind(full[fullIndex]) === 'reasoning'
    ) {
      replayedReasoning = true;
      fullIndex += 1;
    }
    if (
      fullIndex >= full.length
      || fullHashes[fullIndex] !== exactPrefixHashes[expectedIndex]
    ) break;
    expectedIndex += 1;
    fullIndex += 1;
  }
  if (
    expectedIndex === exactPrefixHashes.length
    && fullIndex < full.length
    && (replayedReasoning || omittedReasoning)
  ) {
    return {
      delta: full.slice(fullIndex),
      mode: replayedReasoning ? 'replayed_reasoning' : 'omitted_reasoning',
    };
  }

  // Claude can round-trip OpenAI's encrypted reasoning through an Anthropic
  // thinking block, but the SDK reconstructs a semantically equivalent
  // Responses reasoning envelope whose non-semantic fields/summary need not be
  // byte-identical. The opaque reasoning already belongs to
  // previous_response_id. Ignore only those envelopes while still requiring
  // the request history and every visible assistant item/tool call to match
  // exactly, then send only the items after Claude's echoed assistant output.
  if (
    assistantKinds.includes('reasoning')
    && fullHashes.slice(0, requestHashes.length)
      .every((hash, index) => hash === requestHashes[index])
  ) {
    let fullIndex = requestHashes.length;
    let expectedIndex = 0;
    let ignoredReasoning = false;
    let replayedReasoning = false;
    while (expectedIndex < assistantHashes.length) {
      if (assistantKinds[expectedIndex] === 'reasoning') {
        ignoredReasoning = true;
        expectedIndex += 1;
        while (
          fullIndex < full.length
          && conversationItemKind(full[fullIndex]) === 'reasoning'
        ) {
          replayedReasoning = true;
          fullIndex += 1;
        }
        continue;
      }
      if (fullIndex >= full.length || fullHashes[fullIndex] !== assistantHashes[expectedIndex]) break;
      expectedIndex += 1;
      fullIndex += 1;
    }
    if (
      ignoredReasoning
      && replayedReasoning
      && expectedIndex === assistantHashes.length
      && fullIndex < full.length
    ) {
      return { delta: full.slice(fullIndex), mode: 'replayed_reasoning' };
    }
  }

  // Claude cannot echo opaque OpenAI reasoning/compaction items through its
  // Anthropic-format history, even though it faithfully echoes the function
  // call or assistant text that followed them. Those opaque items already
  // belong to previous_response_id, so continuation remains safe only when all
  // remaining response items still match exactly.
  const echoedAssistantHashes = assistantHashes.filter((_, index) => {
    const kind = assistantKinds[index]!;
    return kind !== 'reasoning' && !isOpaqueCompactionKind(kind);
  });
  if (echoedAssistantHashes.length !== assistantHashes.length) {
    const echoablePrefix = [...requestHashes, ...echoedAssistantHashes];
    if (
      full.length > echoablePrefix.length
      && fullHashes.slice(0, echoablePrefix.length)
        .every((hash, index) => hash === echoablePrefix[index])
    ) {
      return { delta: full.slice(echoablePrefix.length), mode: 'omitted_reasoning' };
    }
  }
  return claudeCompactionContinuationMatch(entry, payload);
}

export function continuationMatch(
  entry: ConnectionEntry,
  payload: JsonObject,
  prepared?: PreparedConversationItems,
): ContinuationMatch | undefined {
  if (!entry.responseId) return undefined;
  return historyContinuationMatch(entry, payload, prepared);
}
