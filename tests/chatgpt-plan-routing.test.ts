import { expect, it } from 'bun:test';
import { prepareResponsesRequest } from '../src/oauth/responses-websocket/request/setup.js';

it('prepares Claude tools and input for ChatGPT plan Responses', () => {
  const prepared = prepareResponsesRequest('wss://api.openai.com/v1/responses', {
    body: JSON.stringify({ model: 'gpt-6.1-sol', store: true,
      input: [{ type: 'message', role: 'system', content: 'instructions' }],
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'read_file' },
    }),
  }, {});
  expect(prepared.payload.store).toBe(false);
  expect(prepared.payload.input).toEqual([{ type: 'message', role: 'developer', content: 'instructions' }]);
  expect(prepared.payload.tools).toEqual([{ type: 'namespace', name: 'clodex',
    description: 'Tools executed by the Clodex client',
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
  }]);
  expect(prepared.payload.tool_choice).toEqual({ type: 'function', name: 'read_file', namespace: 'clodex' });
});
