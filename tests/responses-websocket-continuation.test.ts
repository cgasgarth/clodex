import { describe, expect, it } from 'bun:test';
import {
  conversationItemHash,
  conversationItemKind,
  historyContinuationMatch,
  prepareConversationItems,
  queuedEventItemHashes,
  type ContinuationSource,
} from '../src/oauth/responses-websocket/continuation.js';

function cachedSource(
  requestInput: unknown[],
  expectedAssistant: unknown[],
  queuedEventHashes: string[] = [],
): ContinuationSource {
  return {
    requestInputHashes: requestInput.map(conversationItemHash),
    requestInputKinds: requestInput.map(conversationItemKind),
    expectedAssistantHashes: expectedAssistant.map(conversationItemHash),
    expectedAssistantKinds: expectedAssistant.map(conversationItemKind),
    queuedEventHashes,
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

  it('retains a task event when Claude omits it from the next replay', () => {
    const user = { role: 'user', content: [{ type: 'input_text', text: 'run checks' }] };
    const event = {
      role: 'developer',
      content: '<task-notification><status>completed</status></task-notification>',
    };
    const call = {
      type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"result.txt"}',
    };
    const output = { type: 'function_call_output', call_id: 'call_1', output: 'passed' };
    const payload = { input: [user, call, output] };

    expect(historyContinuationMatch(
      cachedSource([user, event], [call], queuedEventItemHashes([event])),
      payload,
      prepareConversationItems(payload),
    )).toEqual({ delta: [output], mode: 'omitted_queued_event' });

    const userEvent = {
      role: 'user',
      content: [{ type: 'input_text', text: event.content }],
    };
    expect(queuedEventItemHashes([userEvent])).toHaveLength(1);
  });

  it('retains a queued human steer but not an ordinary omitted user item', () => {
    const initial = { role: 'user', content: [{ type: 'input_text', text: 'start' }] };
    const steer = {
      role: 'user',
      content: [{
        type: 'input_text',
        text: 'The user sent a new message while you were working:\nchange direction\n\n'
          + 'Address the message above as you continue this turn.',
      }],
    };
    const ordinary = { role: 'user', content: [{ type: 'input_text', text: 'ordinary' }] };
    const assistant = {
      role: 'assistant', content: [{ type: 'output_text', text: 'working' }],
    };
    const next = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const payload = { input: [initial, assistant, next] };

    expect(historyContinuationMatch(
      cachedSource([initial, steer], [assistant], queuedEventItemHashes([steer])),
      payload,
      prepareConversationItems(payload),
    )).toEqual({ delta: [next], mode: 'omitted_queued_event' });
    expect(historyContinuationMatch(
      cachedSource([initial, ordinary], [assistant]),
      payload,
      prepareConversationItems(payload),
    )).toBeUndefined();
  });

  it('retains Claude tool-rejection state when its next replay omits the interruption record', () => {
    const initial = { role: 'user', content: [{ type: 'input_text', text: 'start' }] };
    const rejected = {
      type: 'function_call_output',
      call_id: 'call_rejected',
      output: 'The user doesn\'t want to proceed with this tool use. '
        + 'The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). '
        + 'STOP what you are doing and wait for the user to tell you how to proceed.',
    };
    const interruptedUser = {
      role: 'user', content: [{ type: 'input_text', text: 'change direction' }],
    };
    const assistant = {
      role: 'assistant', content: [{ type: 'output_text', text: 'changed' }],
    };
    const next = { role: 'user', content: [{ type: 'input_text', text: 'continue' }] };
    const payload = { input: [initial, interruptedUser, assistant, next] };

    expect(queuedEventItemHashes([rejected])).toHaveLength(1);
    expect(historyContinuationMatch(
      cachedSource(
        [initial, rejected, interruptedUser],
        [assistant],
        queuedEventItemHashes([rejected]),
      ),
      payload,
      prepareConversationItems(payload),
    )).toEqual({ delta: [next], mode: 'omitted_queued_event' });
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
