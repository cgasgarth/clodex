import { describe, expect, it } from 'bun:test';
import {
  conversationItemHash,
  conversationItemKind,
  historyContinuationMatch,
  prepareConversationItems,
  type ContinuationSource,
} from '../src/oauth/responses-websocket/continuation.js';

function cachedSource(requestInput: unknown[], expectedAssistant: unknown[]): ContinuationSource {
  return {
    requestInputHashes: requestInput.map(conversationItemHash),
    requestInputKinds: requestInput.map(conversationItemKind),
    expectedAssistantHashes: expectedAssistant.map(conversationItemHash),
    expectedAssistantKinds: expectedAssistant.map(conversationItemKind),
  };
}

describe('prepared conversation continuation matching', () => {
  it('reuses one prepared conversation across candidate heads', () => {
    const user = { role: 'user', content: [{ type: 'input_text', text: 'start' }] };
    const assistant = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
    const next = { role: 'user', content: [{ type: 'input_text', text: 'continue' }] };
    const payload = { input: [user, assistant, next] };
    const prepared = prepareConversationItems(payload);

    expect(historyContinuationMatch(
      cachedSource([{ ...user, content: [{ type: 'input_text', text: 'other' }] }], [assistant]),
      payload,
      prepared,
    )).toBeUndefined();
    expect(historyContinuationMatch(
      cachedSource([user], [assistant]),
      payload,
      prepared,
    )).toEqual({ delta: [next], mode: 'exact' });
  });

  it('keeps canonical function-call argument matching with cached hashes', () => {
    const user = { role: 'user', content: [{ type: 'input_text', text: 'run' }] };
    const storedCall = { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"b":2,"a":1}' };
    const replayedCall = { ...storedCall, arguments: '{ "a": 1, "b": 2 }' };
    const output = { type: 'function_call_output', call_id: 'call_1', output: 'ok' };
    const payload = { input: [user, replayedCall, output] };

    expect(historyContinuationMatch(
      cachedSource([user], [storedCall]),
      payload,
      prepareConversationItems(payload),
    )).toEqual({ delta: [output], mode: 'exact' });
  });

  it('reuses a compact checkpoint when Claude reshapes reasoning throughout old history', () => {
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'start' }] };
    const firstReasoning = {
      type: 'reasoning', id: 'rs_old_1', encrypted_content: 'old-1',
      summary: [{ type: 'summary_text', text: 'old summary' }],
    };
    const call = {
      type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const output = { type: 'function_call_output', call_id: 'call_1', output: '/tmp' };
    const secondReasoning = {
      type: 'reasoning', id: 'rs_old_2', encrypted_content: 'old-2', summary: [],
    };
    const assistant = {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
    };
    const next = { role: 'user', content: [{ type: 'input_text', text: 'continue' }] };
    const source = cachedSource(
      [firstUser, firstReasoning, call, output, secondReasoning],
      [assistant],
    );
    const payload = { input: [
      firstUser,
      { type: 'reasoning', encrypted_content: 'replayed-1', summary: [] },
      call,
      output,
      { type: 'reasoning', encrypted_content: 'replayed-2', summary: [{ type: 'summary_text', text: 'new' }] },
      assistant,
      next,
    ] };

    expect(historyContinuationMatch(source, payload, prepareConversationItems(payload)))
      .toEqual({ delta: [next], mode: 'replayed_reasoning' });
  });

  it('does not reuse a checkpoint when visible history changes beside replayed reasoning', () => {
    const user = { role: 'user', content: [{ type: 'input_text', text: 'start' }] };
    const reasoning = { type: 'reasoning', encrypted_content: 'old', summary: [] };
    const call = {
      type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const assistant = {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
    };
    const changedCall = { ...call, arguments: '{"command":"whoami"}' };
    const next = { role: 'user', content: [{ type: 'input_text', text: 'continue' }] };
    const payload = { input: [
      user,
      { type: 'reasoning', encrypted_content: 'replayed', summary: [] },
      changedCall,
      assistant,
      next,
    ] };

    expect(historyContinuationMatch(
      cachedSource([user, reasoning, call], [assistant]),
      payload,
      prepareConversationItems(payload),
    )).toBeUndefined();
  });
});
