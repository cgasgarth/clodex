import { expect, it } from 'bun:test';
import {
  REHOMED_INSTRUCTIONS_BOOTSTRAP,
  RESPONSES_INSTRUCTION_CHUNK_CHARACTERS,
  RESPONSES_INSTRUCTIONS_MAX_CHARACTERS,
  rehomeOversizedResponsesInstructions,
} from '../src/oauth/responses-websocket/request/instructions.js';
import type { JsonObject } from '../src/oauth/responses-websocket/types.js';

function developerText(item: JsonObject): string {
  // SAFETY: The helper creates each developer item with one input_text part.
  const content = item.content as JsonObject[];
  // SAFETY: The helper creates input_text with a string text field.
  return content[0]!.text as string;
}

it('leaves accepted Responses instructions byte-for-byte unchanged', () => {
  const payload = {
    instructions: 'x'.repeat(RESPONSES_INSTRUCTIONS_MAX_CHARACTERS),
    input: [],
  };

  expect(rehomeOversizedResponsesInstructions(payload)).toEqual({ payload });
});

it('re-homes oversized Responses instructions without dropping content', () => {
  const instructions = `${'x'.repeat(RESPONSES_INSTRUCTIONS_MAX_CHARACTERS)}😀tail`;
  const originalInput = [{ role: 'user', content: 'continue' }];
  const source = { instructions, input: originalInput };

  const result = rehomeOversizedResponsesInstructions(source);
  // SAFETY: The helper replaces oversized instructions with JSON object input items.
  const input = result.payload.input as JsonObject[];
  const chunks = input.slice(0, result.metadata!.chunkCount).map(developerText);

  expect(result.payload).not.toBe(source);
  expect(source).toEqual({ instructions, input: originalInput });
  expect(result.payload.instructions).toBe(REHOMED_INSTRUCTIONS_BOOTSTRAP);
  expect(chunks.join('')).toBe(instructions);
  expect(Math.max(...chunks.map(chunk => chunk.length)))
    .toBeLessThanOrEqual(RESPONSES_INSTRUCTION_CHUNK_CHARACTERS);
  expect(input.at(-1)).toEqual(originalInput[0]);
  expect(result.metadata).toEqual({
    originalCharacters: instructions.length,
    chunkCount: 5,
    largestChunkCharacters: RESPONSES_INSTRUCTION_CHUNK_CHARACTERS,
  });
});

it('preserves shorthand string input as a user message while re-homing', () => {
  const result = rehomeOversizedResponsesInstructions({
    instructions: 'x'.repeat(RESPONSES_INSTRUCTIONS_MAX_CHARACTERS + 1),
    input: 'hello',
  });

  // SAFETY: The helper replaces oversized instructions with JSON object input items.
  expect((result.payload.input as JsonObject[]).at(-1)).toEqual({
    role: 'user',
    content: [{ type: 'input_text', text: 'hello' }],
  });
});
