import { isString } from '../../../runtime/type-guards.js';
import type { JsonObject, JsonValue } from '../types.js';

/** Hard string limit returned by the Responses API for `instructions`. */
export const RESPONSES_INSTRUCTIONS_MAX_CHARACTERS = 1_048_576;

// Keep every moved block well below the per-string ceiling. This also bounds
// the size of one conversation item when a compact request is split in stages.
export const RESPONSES_INSTRUCTION_CHUNK_CHARACTERS = 256 * 1_024;

export const REHOMED_INSTRUCTIONS_BOOTSTRAP =
  'The complete current instructions are the leading developer messages in this input. Apply them in order.';

interface RehomedInstructionsMetadata {
  originalCharacters: number;
  chunkCount: number;
  largestChunkCharacters: number;
}

interface RehomedInstructionsResult {
  payload: JsonObject;
  metadata?: RehomedInstructionsMetadata;
}

function splitWithoutBreakingSurrogates(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + RESPONSES_INSTRUCTION_CHUNK_CHARACTERS, text.length);
    const finalCodeUnit = text.charCodeAt(end - 1);
    if (end < text.length && finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function userInputItem(text: string): JsonObject {
  return {
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

function inputItems(input: JsonValue): JsonValue[] {
  if (Array.isArray(input)) return input;
  return isString(input) ? [userInputItem(input)] : [];
}

function developerInputItem(text: string): JsonObject {
  return {
    role: 'developer',
    content: [{ type: 'input_text', text }],
  };
}

/**
 * Move an oversized top-level instruction into ordered developer messages.
 *
 * Responses gives developer messages the same instruction priority while its
 * compaction transports operate only after request-shape validation. Re-homing
 * makes the request valid first, then lets the existing native compaction and
 * continuation planners treat the instruction blocks as ordinary canonical
 * input. The source payload is never mutated.
 */
export function rehomeOversizedResponsesInstructions(
  payload: JsonObject,
): RehomedInstructionsResult {
  const instructions = payload.instructions;
  if (!isString(instructions) || instructions.length <= RESPONSES_INSTRUCTIONS_MAX_CHARACTERS) {
    return { payload };
  }

  const chunks = splitWithoutBreakingSurrogates(instructions);
  return {
    payload: {
      ...payload,
      instructions: REHOMED_INSTRUCTIONS_BOOTSTRAP,
      input: [
        ...chunks.map(developerInputItem),
        ...inputItems(payload.input),
      ],
    },
    metadata: {
      originalCharacters: instructions.length,
      chunkCount: chunks.length,
      largestChunkCharacters: Math.max(...chunks.map(chunk => chunk.length)),
    },
  };
}
