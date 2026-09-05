import { describe, expect, it } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { claudeQueuedEventKind, splitClaudeQueuedToolText } from '../src/claude-queued-events.js';
import { generateAnthropicResponse, translateRequest, queuedInputDiagnostics } from '../src/sdk-adapter.js';
import { historyContinuationMatch, queuedEventItemHashes } from '../src/oauth/responses-websocket/continuation.js';
import type { JsonObject } from '../src/oauth/responses-websocket/types.js';
import events from './fixtures/claude-queued-events.json';

// Captured with Claude Code 2.1.261 against a local mock endpoint. Task ids and
// paths are synthetic. The harness places this envelope inside tool_result.
describe('Claude queued events inside tool results', () => {
  it.each(['task', 'human'] as const)('recognizes the wrapped %s envelope', kind => {
    expect(claudeQueuedEventKind(events[kind])).toBe(kind);
    expect(splitClaudeQueuedToolText(`result\n\n${events[kind]}`)).toEqual({
      toolText: 'result', events: [{ kind, text: events[kind] }],
    });
  });

  it('keeps unrelated reminders and preserves event order', () => {
    const reminder = '<system-reminder>\nA file changed on disk.\n</system-reminder>';
    expect(splitClaudeQueuedToolText(`result\n\n${events.task}\n\n${reminder}\n\n${events.human}`))
      .toEqual({
        toolText: `result\n\n${reminder}`,
        events: [{ kind: 'task', text: events.task }, { kind: 'human', text: events.human }],
      });
  });

  it.each([
    'A tool printed <task-notification><status>completed</status></task-notification>',
    `File example:\n${events.task}\nEnd of file.`,
    'result\n\n<system-reminder>\n<task-notification>incomplete',
    '<system-reminder>\nOrdinary tool data.\n</system-reminder>',
  ])('keeps ordinary or incomplete tool data in its channel: %s', text => {
    expect(splitClaudeQueuedToolText(text)).toEqual({ toolText: text, events: [] });
  });

  it.each(['string', 'blocks'] as const)('delivers events from %s results before the next tool output', encoding => {
    const text = `boundary\n\n${events.task}\n\n${events.human}`;
    const content = encoding === 'string' ? text : [{ type: 'text', text }];
    const body = {
      model: 'astra',
      messages: [{ role: 'user' as const, content: [
        { type: 'tool_result', tool_use_id: 'call_1', content },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'next output' },
      ] }],
    };
    const before = JSON.stringify(body);
    const params = translateRequest(body, '@ai-sdk/openai', { openAiOAuth: true });
    expect(params.messages.map(m => m.role)).toEqual(['tool', 'system', 'user', 'tool']);
    expect(params.messages[1]).toEqual({ role: 'system', content: events.task });
    expect(params.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: events.human }] });
    expect(params.messages[0]).toMatchObject({ content: [{ output: {
      type: 'text', value: encoding === 'string' ? 'boundary' : JSON.stringify([{ type: 'text', text: 'boundary' }]),
    } }] });
    expect(params.providerOptions?.openai?.instructions).not.toContain(events.task);
    expect(queuedInputDiagnostics(body.messages)).toEqual({ humanSteeringMessages: 1, trustedTaskNotifications: 1 });
    // Translation can annotate tool names, but must not consume source events.
    expect(JSON.stringify(body, (key, value) => key === '_name' ? undefined : value)).toBe(before);
    expect(translateRequest(body, '@ai-sdk/openai', { openAiOAuth: true }).messages).toEqual(params.messages);
  });

  it('retains wrapped inline system task events at their source position', () => {
    const params = translateRequest({ model: 'astra', messages: [
      { role: 'user', content: 'work' },
      { role: 'system', content: events.task },
      { role: 'user', content: 'next' },
    ] }, '@ai-sdk/openai', { openAiOAuth: true });
    expect(params.messages.map(m => m.role)).toEqual(['user', 'system', 'user']);
    expect(params.messages[1]?.content).toBe(events.task);
  });

  it.each(['task', 'human'] as const)('retains an omitted wrapped %s event in Responses continuation', kind => {
    const event = { role: kind === 'task' ? 'developer' : 'user', content: events[kind] };
    const start = { role: 'user', content: 'work' };
    const assistant = { role: 'assistant', content: 'continuing' };
    const next = { role: 'user', content: 'next' };
    expect(queuedEventItemHashes([event])).toHaveLength(1);
    expect(historyContinuationMatch({ requestInput: [start, event], expectedAssistant: [assistant],
      queuedEventHashes: queuedEventItemHashes([event]),
    }, { input: [start, assistant, next] })).toEqual({ mode: 'omitted_queued_event', delta: [next] });
  });

  it.each(['background command', 'workflow', 'subagent'])('serializes a %s completion and user steering as separate Responses input', async kind => {
    const task = events.task.replace('Probe failed background command', `Probe ${kind}`);
    let captured: JsonObject | undefined;
    const provider = createOpenAI({ apiKey: 'local-test', fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return Response.json({ id: 'resp_event_probe', model: 'gpt-6-astra', output: [],
        usage: { input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 } } });
    } });
    await generateAnthropicResponse(provider.responses('gpt-6-astra'), translateRequest({
      model: 'astra', messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1',
          content: `tool output\n\n${task}\n\n${events.human}` }] },
      ],
    }, '@ai-sdk/openai', { openAiOAuth: true }), 'astra');
    expect(captured?.input).toMatchObject([
      { type: 'function_call', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: 'tool output' },
      { role: 'developer', content: task },
      { role: 'user', content: [{ type: 'input_text', text: events.human }] },
    ]);
  });
});
