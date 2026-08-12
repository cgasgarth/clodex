import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';

// Fake `ws` WebSocket that records constructor args and lets tests drive events.
const { fakeSockets } = createHoisted(() => ({ fakeSockets: [] as FakeWebSocket[] }));

class FakeWebSocket extends EventEmitter {
  url: string;
  options: { headers?: Record<string, string> };
  send = vi.fn();
  close = vi.fn();
  constructor(url: string, options: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options;
    fakeSockets.push(this);
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));

import {
  createResponsesWebSocketFetch as createResponsesWebSocketFetchBase,
  resetResponsesWebSocketConnectionsForTests,
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFingerprint,
  withResponsesWebSocketDiagnosticContext,
  type ResponsesWebSocketDiagnosticEvent,
} from '../src/oauth/responses-websocket.js';
import { saveStoredResponsesCheckpoint } from '../src/oauth/responses-checkpoint-store.js';
import { sdkUpstreamErrorDetails } from '../src/upstream-error.js';
import { createHoisted, waitForCondition } from './test-helpers.js';

const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';

const createResponsesWebSocketFetch: typeof createResponsesWebSocketFetchBase = (
  url,
  log,
  options = {},
) => createResponsesWebSocketFetchBase(url, log, {
  ...options,
  webSocketConstructor: FakeWebSocket as never,
});

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function lastSocket(): FakeWebSocket {
  return fakeSockets[fakeSockets.length - 1]!;
}

const sessionPayload = (input: unknown[], extra: Record<string, unknown> = {}) => ({
  model: 'gpt-5.6-sol',
  prompt_cache_key: 'relay-session-abc',
  instructions: 'You are a coding assistant.',
  tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
  reasoning: { effort: 'high' },
  store: false,
  input,
  ...extra,
});

function checkpointItemHash(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.keys(input as Record<string, unknown>)
      .sort()
      .filter(key => (input as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, canonicalize((input as Record<string, unknown>)[key])]));
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex').slice(0, 16);
}

/** Drive a failed WebSocket upgrade by emitting `unexpected-response`. */
function rejectUpgrade(
  socket: FakeWebSocket,
  statusCode: number,
  opts: { headers?: Record<string, string>; statusMessage?: string } = {},
): { resume: ReturnType<typeof vi.fn> } {
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    statusMessage: opts.statusMessage ?? '',
    headers: opts.headers ?? {},
    resume: vi.fn(),
  });
  socket.emit('unexpected-response', {}, response);
  return response;
}

/** Parse the single SSE error frame produced by a failed request. */
async function readErrorFrame(res: Response): Promise<{
  type: string;
  sequence_number: number;
  error: Record<string, unknown>;
}> {
  const body = await readAll(res);
  return JSON.parse(body.replace(/^data: /, '').trim());
}

/** Run the SSE error body through the real AI SDK and classify the surfaced error. */
async function classifyThroughSdk(sseBody: string): Promise<ReturnType<typeof sdkUpstreamErrorDetails>> {
  const provider = createOpenAI({
    apiKey: 'test-only',
    fetch: async () => new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  });
  const streamed = streamText({
    model: provider.responses('gpt-5.6-sol'),
    prompt: 'test',
    maxRetries: 0,
    onError: () => {},
  });
  let upstreamError: unknown;
  for await (const part of streamed.stream) {
    if (part.type === 'error') upstreamError = part.error;
  }
  return sdkUpstreamErrorDetails(upstreamError);
}

function emitTextResponse(
  socket: FakeWebSocket,
  responseId: string,
  text: string,
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens: number;
  },
): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id: responseId },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.added', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_text.delta', item_id: `msg_${responseId}`, delta: text,
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed', response: { id: responseId, usage },
  })));
}

function emitAssistantMessagesResponse(
  socket: FakeWebSocket,
  responseId: string,
  texts: string[],
): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created',
    response: { id: responseId },
  })));
  texts.forEach((text, outputIndex) => {
    const itemId = `msg_${responseId}_${outputIndex}`;
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: itemId },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      item_id: itemId,
      delta: text,
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: { type: 'message', id: itemId },
    })));
  });
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed',
    response: { id: responseId },
  })));
}

function emitCompactionResponse(
  socket: FakeWebSocket,
  responseId: string,
  encryptedContent: string,
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens: number;
  },
): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id: responseId },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'compaction', id: `cmp_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'compaction',
      id: `cmp_${responseId}`,
      encrypted_content: encryptedContent,
    },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed', response: { id: responseId, usage },
  })));
}

function emitToolCallResponse(
  socket: FakeWebSocket,
  responseId: string,
  callId: string,
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens: number;
  },
): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id: responseId },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'function_call',
      id: `fc_${responseId}`,
      call_id: callId,
      name: 'Bash',
      arguments: '{"command":"pwd"}',
      status: 'completed',
    },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed', response: { id: responseId, usage },
  })));
}

describe('createResponsesWebSocketFetch', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
  });

  it('forwards request headers and adds the WebSocket beta header on the upgrade', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok',
        'ChatGPT-Account-Id': 'acct-123',
        originator: 'clodex',
        version: '0.144.1',
        'x-openai-internal-codex-responses-lite': 'true',
      },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });

    const headers = lastSocket().options.headers ?? {};
    expect(lastSocket().url).toBe(WS_URL);
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['ChatGPT-Account-Id']).toBe('acct-123');
    expect(headers['version']).toBe('0.144.1');
    expect(headers['x-openai-internal-codex-responses-lite']).toBe('true');
    expect(headers['OpenAI-Beta']).toContain('responses_websockets');
  });

  it('sends the payload as the first frame and folds in the Responses-Lite shape', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', reasoning: { effort: 'high' } }),
    });

    const socket = lastSocket();
    socket.emit('open');
    expect(socket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    // Must be a `response.create` event with the Responses fields at top level.
    expect(sent.type).toBe('response.create');
    expect(sent.model).toBe('gpt-5.6-luna');
    expect(sent.parallel_tool_calls).toBe(false);
    expect(sent.store).toBe(false);
    expect(sent.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
  });

  it('does not mutate the body when the Responses-Lite header is absent', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: JSON.stringify({ model: 'gpt-5.6-sol' }),
    });
    const socket = lastSocket();
    socket.emit('open');
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    // Still wrapped in the response.create envelope, but no Responses-Lite fields added.
    expect(sent).toEqual({ type: 'response.create', model: 'gpt-5.6-sol' });
  });

  it('uses the full Responses protocol for native web search on a Lite model', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: {
        version: '0.144.1',
        'x-openai-internal-codex-responses-lite': 'true',
      },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        tools: [{ type: 'web_search' }],
        reasoning: { effort: 'high' },
      }),
    });

    const socket = lastSocket();
    expect(socket.options.headers).not.toHaveProperty('version');
    expect(socket.options.headers).not.toHaveProperty('x-openai-internal-codex-responses-lite');
    socket.emit('open');
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    expect(sent).toEqual({
      type: 'response.create',
      model: 'gpt-5.6-sol',
      tools: [{ type: 'web_search' }],
      reasoning: { effort: 'high' },
    });
  });

  it('collapses each frame onto a single SSE data line and closes on response.completed', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    const socket = lastSocket();
    socket.emit('open');
    // Pretty-printed JSON frame must not become a multi-line SSE event.
    socket.emit('message', Buffer.from('{\n  "type": "response.output_text.delta",\n  "delta": "hi"\n}'));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed' })));

    const body = await readAll(res);
    const lines = body.split('\n\n').filter(Boolean);
    expect(lines[0]).toBe('data: {"type":"response.output_text.delta","delta":"hi"}');
    expect(lines[1]).toBe('data: {"type":"response.completed"}');
    expect(socket.close).toHaveBeenCalled();
  });

  it('logs privacy-safe raw cache usage from the terminal response event', async () => {
    const debug: string[] = [];
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, message => debug.push(message), {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      {
        requestId: 'req-usage',
        claudeSessionId: '927b8642-15d2-4535-ab27-1430ae54c4aa',
      },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_usage',
        usage: {
          input_tokens: 1_200,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 200 },
          output_tokens: 50,
        },
      },
    })));
    await readAll(res);

    expect(debug).toContain(
      'ws: usage input_tokens=1200 cached_tokens=900 cache_write_tokens=200 output_tokens=50',
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_usage',
      requestId: 'req-usage',
      claudeSessionId: '927b8642-15d2-4535-ab27-1430ae54c4aa',
      connectionId: 1,
      generation: 'isolated',
      continued: false,
      retried: false,
      inputTokens: 1_200,
      cachedTokens: 900,
      cacheWriteTokens: 200,
      outputTokens: 50,
    }));
  });

  it('retries a pre-frame socket error once on a fresh socket with full context', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'retry this request' }] },
    ];
    const payload = sessionPayload(input);
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-socket-error' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(payload),
      }),
    );
    const socket = lastSocket();
    const error = Object.assign(new Error('secret socket failure'), { code: 'ECONNRESET' });
    socket.emit('error', error);

    expect(fakeSockets).toHaveLength(2);
    expect(socket.close).toHaveBeenCalledOnce();
    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string)).toEqual({
      type: 'response.create',
      ...payload,
    });
    emitTextResponse(replacement, 'resp_transport_retry', 'recovered');
    expect(await readAll(res)).toContain('recovered');

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      requestId: 'req-socket-error',
      connectionId: 1,
      generation: 'nursery',
      source: 'socket_error',
      socketErrorName: 'Error',
      socketErrorCode: 'ECONNRESET',
      frameCount: 0,
      emittedModelData: false,
      errorMessageBytes: 21,
      errorMessageHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'recovered',
      requestId: 'req-socket-error',
      connectionId: 2,
      frameCount: 1,
      emittedModelData: false,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('secret socket failure');
  });

  it('shares one retry budget across pre-frame socket errors and closes', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });

    const first = lastSocket();
    first.emit(
      'error',
      Object.assign(new Error('first private failure'), { code: 'ECONNRESET' }),
    );
    const replacement = lastSocket();
    replacement.emit('close', 1006, Buffer.from('second private failure'));

    expect(fakeSockets).toHaveLength(2);
    const body = await readAll(res);
    expect(JSON.parse(body.replace(/^data: /, '').trim())).toEqual({
      type: 'error',
      sequence_number: 0,
      error: {
        type: 'transport_error',
        code: 'websocket_transport_error',
        message: 'WebSocket closed (1006): second private failure',
        param: null,
      },
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'exhausted',
      connectionId: 2,
      source: 'socket_close',
      closeCode: 1006,
      frameCount: 0,
      emittedModelData: false,
    }));
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('first private failure');
    expect(serialized).not.toContain('second private failure');
  });

  it('retries a synchronous send failure once on a fresh socket', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const payload = sessionPayload([
      { role: 'user', content: [{ type: 'input_text', text: 'send this request' }] },
    ]);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(payload),
    });
    const first = lastSocket();
    first.send.mockImplementationOnce(() => {
      throw Object.assign(new Error('private synchronous send failure'), { code: 'EPIPE' });
    });

    expect(() => first.emit('open')).not.toThrow();
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string)).toEqual({
      type: 'response.create',
      ...payload,
    });
    emitTextResponse(replacement, 'resp_sync_send_retry', 'recovered');
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      source: 'socket_send',
      failureMode: 'synchronous',
      socketErrorCode: 'EPIPE',
      frameCount: 0,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private synchronous send failure');
  });

  it('retries a callback-reported send failure through the same transport path', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const first = lastSocket();
    first.send.mockImplementationOnce((
      _data: string,
      callback?: (error?: Error) => void,
    ) => {
      callback?.(Object.assign(new Error('private callback send failure'), { code: 'ECONNRESET' }));
    });

    first.emit('open');
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_callback_send_retry', 'recovered');
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      source: 'socket_send',
      failureMode: 'callback',
      socketErrorCode: 'ECONNRESET',
      frameCount: 0,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private callback send failure');
  });

  it('does not create a replacement when cancellation occurs while retiring the failed socket', async () => {
    const controller = new AbortController();
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
      signal: controller.signal,
    });
    const socket = lastSocket();
    socket.close.mockImplementationOnce(() => controller.abort());

    socket.emit(
      'error',
      Object.assign(new Error('private cancelled failure'), { code: 'ECONNRESET' }),
    );

    expect(fakeSockets).toHaveLength(1);
    expect(await readAll(res)).toBe('');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'cancelled',
      connectionId: 1,
      frameCount: 0,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private cancelled failure');
  });

  it('does not retry after any upstream response frame has arrived', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created',
      response: { id: 'resp_started' },
    })));
    socket.emit(
      'error',
      Object.assign(new Error('private post-frame failure'), { code: 'ECONNRESET' }),
    );

    expect(fakeSockets).toHaveLength(1);
    expect(await readAll(res)).toContain('websocket_transport_error');
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      connectionId: 1,
      frameCount: 1,
      emittedModelData: false,
    }));
  });

  it('does not retry after model output has reached the downstream stream', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'partial output',
    })));
    socket.emit(
      'error',
      Object.assign(new Error('post-output failure'), { code: 'ECONNRESET' }),
    );

    expect(fakeSockets).toHaveLength(1);
    const body = await readAll(res);
    expect(body).toContain('partial output');
    expect(body).toContain('websocket_transport_error');
    expect(fakeSockets).toHaveLength(1);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      frameCount: 1,
      emittedModelData: true,
    }));
  });

  it('retries a failed incremental continuation with the complete original context', async () => {
    const initialInput = [
      { role: 'user', content: [{ type: 'input_text', text: 'first turn' }] },
    ];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-transport-continuation',
    });
    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(initialInput)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_transport_base', 'first answer');
    await readAll(first);

    const fullInput = [
      ...initialInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'second turn' }] },
    ];
    const continued = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(fullInput)),
    });
    const incremental = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(incremental.previous_response_id).toBe('resp_transport_base');
    expect(incremental.input).toEqual([fullInput[2]]);

    socket.emit(
      'error',
      Object.assign(new Error('continuation transport failure'), { code: 'ECONNRESET' }),
    );
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const replay = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(replay.previous_response_id).toBeUndefined();
    expect(replay.input).toEqual(fullInput);
    emitTextResponse(replacement, 'resp_transport_recovered', 'second answer');
    await readAll(continued);
  });

  it('retains a retried parallel auxiliary request as a reusable head', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-parallel-transport',
      onDiagnostic: event => diagnostics.push(event),
    });
    const mainInput = [
      { role: 'user', content: [{ type: 'input_text', text: 'main request' }] },
    ];
    const main = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(mainInput)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');

    const auxiliaryInput = [
      { role: 'user', content: [{ type: 'input_text', text: 'auxiliary request' }] },
    ];
    const auxiliary = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(auxiliaryInput)),
    });
    const failedAuxiliarySocket = lastSocket();
    failedAuxiliarySocket.emit(
      'error',
      Object.assign(new Error('auxiliary transport failure'), { code: 'ECONNRESET' }),
    );
    const auxiliaryReplacement = lastSocket();
    auxiliaryReplacement.emit('open');
    emitTextResponse(auxiliaryReplacement, 'resp_auxiliary', 'auxiliary answer');
    await readAll(auxiliary);
    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);

    const nextAuxiliaryInput = [
      ...auxiliaryInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'auxiliary answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'continue auxiliary' }] },
    ];
    const nextAuxiliary = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(nextAuxiliaryInput)),
    });
    expect(fakeSockets).toHaveLength(3);
    const nextAuxiliarySocket = auxiliaryReplacement;
    expect(JSON.parse(nextAuxiliarySocket.send.mock.calls[1]![0] as string)).toMatchObject({
      previous_response_id: 'resp_auxiliary',
      input: [nextAuxiliaryInput.at(-1)],
    });
    emitTextResponse(nextAuxiliarySocket, 'resp_auxiliary_next', 'done');
    await readAll(nextAuxiliary);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'recovered',
      generation: 'nursery',
    }));
  });

  it('terminates an unexpected HTTP upgrade response with a schema-valid stream error', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-upgrade-401' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: { Authorization: 'Bearer private-rejected-token' },
        body: JSON.stringify(
          sessionPayload([
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'private request body' }],
            },
          ]),
        ),
      }),
    );
    const socket = lastSocket();
    const { resume } = rejectUpgrade(socket, 401, {
      statusMessage: 'private response status',
      headers: { 'x-private': 'private response header' },
    });

    const body = await readAll(res);
    const frame = JSON.parse(body.replace(/^data: /, '').trim());
    expect(frame).toEqual({
      type: 'error',
      sequence_number: 0,
      error: {
        type: 'authentication_error',
        code: '401',
        message: 'WebSocket upgrade failed (HTTP 401)',
        param: null,
      },
    });
    expect((await classifyThroughSdk(body))?.statusCode).toBe(401);
    expect(resume).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        event: 'ws_response_error',
        requestId: 'req-upgrade-401',
        source: 'unexpected_response',
        httpStatusCode: 401,
        emittedModelData: false,
      }),
    );
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('private-rejected-token');
    expect(serialized).not.toContain('private request body');
    expect(serialized).not.toContain('private response status');
    expect(serialized).not.toContain('private response header');

    const next = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer private-rejected-token' },
      body: JSON.stringify(
        sessionPayload([
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'replacement request' }],
          },
        ]),
      ),
    });
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_after_401', 'recovered');
    await readAll(next);
  });

  it('maps a 403 upgrade rejection (edge throttle) to a retryable 429 rate limit without reading the body', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-upgrade-403' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ])),
      }),
    );
    // Emit only `unexpected-response` — never body data or `end`. The mapping
    // must be synchronous and status-only.
    const { resume } = rejectUpgrade(lastSocket(), 403);

    const body = await readAll(res);
    const frame = JSON.parse(body.replace(/^data: /, '').trim());
    expect(frame.error.type).toBe('rate_limit_error');
    expect(frame.error.code).toBe('429');
    expect(frame.error.retry_after_seconds).toBe(5);
    expect(frame.error.message).toMatch(/retry after 5s/i);
    expect(resume).toHaveBeenCalledOnce();

    // Through the real AI SDK the failure surfaces as a retryable 429 with the
    // backoff hint — never as the permission error hosts relabel "Please run
    // /login".
    const details = await classifyThroughSdk(body);
    expect(details).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 5,
    });

    // Diagnostics keep the real upstream status alongside the mapping.
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-upgrade-403',
      source: 'unexpected_response',
      httpStatusCode: 403,
      mappedStatusCode: 429,
      retryAfterSeconds: 5,
    }));
  });

  it('honors an upstream retry-after header on a 403 rejection', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });
    rejectUpgrade(lastSocket(), 403, { headers: { 'retry-after': '12' } });

    const frame = await readErrorFrame(res);
    expect(frame.error.type).toBe('rate_limit_error');
    expect(frame.error.retry_after_seconds).toBe(12);
  });

  it('clamps an oversized retry-after header and defaults a malformed one', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);

    const oversized = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });
    rejectUpgrade(lastSocket(), 403, { headers: { 'retry-after': '3600' } });
    const oversizedFrame = await readErrorFrame(oversized);
    expect(oversizedFrame.error.retry_after_seconds).toBe(60);
    // The message text is the only channel that survives the AI SDK's chunk
    // schema stripping, so the CLAMPED value must appear there too.
    expect(oversizedFrame.error.message).toMatch(/retry after 60s\b/i);

    const malformed = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });
    rejectUpgrade(lastSocket(), 403, { headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    const malformedFrame = await readErrorFrame(malformed);
    expect(malformedFrame.error.retry_after_seconds).toBe(5);
    expect(malformedFrame.error.message).toMatch(/retry after 5s\b/i);
  });

  it('handles the 403 synchronously so later socket error/close events cannot retry or double-handle', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'throttled' }] },
      ])),
    });
    const socket = lastSocket();
    rejectUpgrade(socket, 403);
    // ws surfaces transport teardown after a failed upgrade; the pre-frame
    // transport retry (PR #29) must see a finished request and stand down.
    socket.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    socket.emit('close', 1006, Buffer.from(''));

    expect(fakeSockets).toHaveLength(1);
    const frames = (await readAll(res)).split('\n\n').filter(Boolean);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.replace(/^data: /, '')).error.type).toBe('rate_limit_error');
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
    }));
  });

  it('lets the AI SDK transparently retry a 403-throttled upgrade and recover', async () => {
    // The design premise of the 403->429 mapping: because the synthetic error
    // frame arrives BEFORE any output chunk, @ai-sdk/openai's
    // throwIfOpenAIStreamErrorBeforeOutput rejects doStream with a retryable
    // 429 APICallError, so the AI SDK's own retry loop re-attempts the whole
    // request — including a fresh WebSocket upgrade. This drives that loop for
    // real: attempt 1 gets a 403 upgrade rejection, attempt 2 succeeds.
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const provider = createOpenAI({ apiKey: 'test-only', fetch: wsFetch });
    const streamed = streamText({
      model: provider.responses('gpt-5.6-sol'),
      prompt: 'retry me',
      maxRetries: 1,
      onError: () => {},
    });
    const collected = (async () => {
      let out = '';
      for await (const chunk of streamed.textStream) out += chunk;
      return out;
    })();

    await waitForCondition(() => expect(fakeSockets).toHaveLength(1));
    rejectUpgrade(lastSocket(), 403);

    // The SDK backs off (no retry-after header on the synthetic SSE response,
    // so its default ~2s exponential delay) and opens a SECOND upgrade.
    await waitForCondition(() => expect(fakeSockets).toHaveLength(2), { timeout: 10_000 });
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_retry_recovered', 'recovered');

    // Transparent recovery: the caller sees only the successful text.
    await expect(collected).resolves.toBe('recovered');
    expect(fakeSockets).toHaveLength(2);
  }, 20_000);

  it('maps an in-band WebSocket connection limit error to a retryable 429', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-connection-limit' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
        body: JSON.stringify(sessionPayload([])),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        code: 'websocket_connection_limit_reached',
        message: 'connection limit reached',
        retry_after_seconds: 12,
      },
    })));

    const body = await readAll(res);
    expect(JSON.parse(body.replace(/^data: /, '').trim())).toEqual({
      type: 'error',
      sequence_number: 1,
      error: {
        type: 'rate_limit_error',
        code: '429',
        message: 'OpenAI reported the Responses WebSocket connection limit was reached; retry after 12s',
        param: null,
        retry_after_seconds: 12,
      },
    });
    expect(body).not.toContain('transport_error');
    expect(await classifyThroughSdk(body)).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 12,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-connection-limit',
      source: 'error_frame',
      errorCode: 'websocket_connection_limit_reached',
      mappedStatusCode: 429,
      retryAfterSeconds: 12,
      emittedModelData: false,
    }));
  });

  it('maps an in-band rejected request to its upstream status instead of an empty stream', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-unsupported-parameter' },
      () => wsFetch('https://x', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
        body: JSON.stringify(sessionPayload([])),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        message: "Unsupported parameter: 'reasoning.summary' is not supported with the 'test-model' model.",
        param: 'reasoning.summary',
      },
      status: 400,
    })));

    const body = await readAll(res);
    expect(await readErrorFrame(new Response(body))).toEqual({
      type: 'error',
      sequence_number: 1,
      error: {
        type: 'invalid_request_error',
        code: '400',
        message: "Unsupported parameter: 'reasoning.summary' is not supported with the 'test-model' model.",
        param: null,
      },
    });
    // The failure must reach the caller as a 400, not as a content-free 200.
    expect(await classifyThroughSdk(body)).toMatchObject({
      statusCode: 400,
      isRetryable: false,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-unsupported-parameter',
      source: 'error_frame',
      errorCode: 'unsupported_parameter',
      mappedStatusCode: 400,
      emittedModelData: false,
    }));
    // One rejection, one record. The generic `response_event` record is
    // suppressed so a diagnostics consumer does not read one failed request as
    // two distinct failures under disjoint field sets.
    expect(diagnostics.filter(event => event.event === 'ws_response_error')).toHaveLength(1);
  });

  it('bounds an upstream-controlled error code in the rejection diagnostic', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      // Hostile: overlong and newline-bearing, so it would corrupt a log line
      // if forwarded verbatim the way the raw value was.
      error: { type: 'invalid_request_error', code: `${'c'.repeat(400)}\nsecond line`, message: 'nope' },
      status: 400,
    })));
    await readAll(res);

    const record = diagnostics.find(event => event.event === 'ws_response_error');
    expect(record).toMatchObject({ source: 'error_frame', mappedStatusCode: 400 });
    // Rejected outright rather than truncated — same discipline every other
    // identifier in this file's diagnostics already follows.
    expect(record?.errorCode).toBeUndefined();
  });

  it('carries an in-band 429 backoff hint through as message text', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'usage limit reached', retry_after_seconds: 45 },
      status: 429,
    })));

    const body = await readAll(res);
    // The AI SDK strips unknown frame fields, so the hint only survives baked
    // into the message — which is how the consumer recovers it.
    expect(body).toContain('retry after 45s');
    expect(await classifyThroughSdk(body)).toMatchObject({
      statusCode: 429,
      isRetryable: true,
      retryAfterSeconds: 45,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      source: 'error_frame',
      // The record that survives dedup must still name the failure.
      errorType: 'rate_limit_error',
      retryAfterSeconds: 45,
    }));
  });

  it('clamps an absurd in-band backoff hint', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down', retry_after_seconds: 86400 },
      status: 429,
    })));

    // Bounded so a hostile hint cannot park a client past the 120s stream abort.
    expect(await readAll(res)).toContain('retry after 60s');
  });

  it('states no backoff hint on a 429 when upstream gave none', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      // A plan-level limit: the reason is stated in prose, on an hours scale.
      error: { type: 'usage_limit_reached', message: 'Usage limit reached. Resets in 4 hours.' },
      status: 429,
    })));

    const body = await readAll(res);
    expect(body).toContain('Resets in 4 hours.');
    // Inventing a hint here would become a real `retry-after: 5` header and
    // send the client back long before the limit resets.
    expect(body).not.toContain('retry after');
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 429 });
  });

  it('reads a status nested under error, not only the top-level one', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'nested status', status: 400 },
    })));

    expect(await classifyThroughSdk(await readAll(res))).toMatchObject({ statusCode: 400 });
  });

  // The fall-through cases. `status` must be an HTTP error code specifically —
  // a success status is not a rejection, and `response.status` is a lifecycle
  // string this must never mistake for one.
  it.each([
    ['a non-error status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, status: 200 }],
    ['a lifecycle response status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, response: { status: 'failed' } }],
    ['a fractional status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, status: 400.5 }],
    // `response.status` is a lifecycle state, never an HTTP code. Pinned with a
    // NUMERIC value on purpose: a string one is rejected by the type guard
    // anyway, so only this shape can catch a future edit that starts consulting
    // that field and reports a lifecycle position as a status.
    ['a numeric response status', { type: 'error', error: { type: 'server_error', message: 'keep me' }, response: { status: 400 } }],
  ])('leaves a frame carrying %s to the existing path', async (_label, frame) => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify(frame)));

    const body = await readAll(res);
    expect(body).toContain('keep me');
    // Not rewritten into a synthetic frame: no status was recovered, so the
    // original is forwarded exactly as before this branch existed.
    expect(body).not.toContain('"code":"200"');
    expect(await classifyThroughSdk(body)).toBeUndefined();
  });

  // Each message source the helper consults, pinned separately — otherwise a
  // "simplification" that drops one of the fallbacks ships green.
  it.each([
    ['nested under response.error', { type: 'error', status: 400, response: { error: { message: 'from response error' } } }, 'from response error'],
    ['on the frame itself', { type: 'error', status: 400, message: 'from the frame' }, 'from the frame'],
  ])('recovers a rejection message %s', async (_label, frame, expected) => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify(frame)));

    expect(await readAll(res)).toContain(expected);
  });

  it('falls back to a generic reason when a rejection carries no message', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'error', status: 503 })));

    const body = await readAll(res);
    expect(body).toContain('OpenAI rejected the request (HTTP 503)');
    expect(await classifyThroughSdk(body)).toMatchObject({ statusCode: 503 });
  });

  it('leaves a status-carrying error frame alone once model data is downstream', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta', delta: 'partial',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'server_error', code: 'internal_error', message: 'late failure' },
      status: 500,
    })));

    // Already-committed stream: the frame is forwarded verbatim, not rewritten
    // into a synthetic error that would contradict the emitted output.
    const body = await readAll(res);
    expect(body).toContain('partial');
    // Assert the ORIGINAL frame is still there, not merely that the synthetic
    // one is absent: `not.toContain` alone passes just as happily when the
    // frame is dropped entirely, which is the regression this test exists to
    // catch. Both halves are required.
    expect(body).toContain('late failure');
    expect(body).toContain('"status":500');
    expect(body).not.toContain('"code":"500"');
  });

  it('logs sanitized upstream response failure details after partial output', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-response-failed' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
    const socket = lastSocket();
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'partial',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_failed',
        status: 'failed',
        error: {
          type: 'server_error',
          code: 'internal_error',
          message: 'sensitive backend explanation',
        },
      },
    })));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-response-failed',
      connectionId: 1,
      source: 'response_event',
      upstreamEventType: 'response.failed',
      errorType: 'server_error',
      errorCode: 'internal_error',
      responseStatus: 'failed',
      emittedModelData: true,
      willRetry: false,
      errorMessageBytes: 29,
      errorMessageHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive backend explanation');
  });

  it('logs a content-free anomaly when reasoning delta has no matching start', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-reasoning-anomaly' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: JSON.stringify({ store: false }) }),
    );
    const socket = lastSocket();
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'sensitive-reasoning-item-id',
      summary_index: 0,
      delta: 'sensitive reasoning text',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_anomaly' },
    })));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_protocol_anomaly',
      requestId: 'req-reasoning-anomaly',
      connectionId: 1,
      source: 'response_event_sequence',
      anomaly: 'reasoning_start_missing_before_delta',
      upstreamEventType: 'response.reasoning_summary_text.delta',
      itemIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      summaryIndex: 0,
      knownSummaryParts: [],
      recentUpstreamEventTypes: ['response.reasoning_summary_text.delta'],
      emittedModelData: false,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive-reasoning-item-id');
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive reasoning text');
  });

  it('accepts a correctly sequenced multi-part reasoning response', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify({ store: false }),
    });
    const socket = lastSocket();
    const events = [
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1' },
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1',
        summary_index: 0, delta: 'first',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-1', summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_part.added', item_id: 'reasoning-1', summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1',
        summary_index: 1, delta: 'second',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-1', summary_index: 1,
      },
      {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1' },
      },
      { type: 'response.completed', response: { id: 'resp_reasoning' } },
    ];
    for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
    await readAll(res);

    expect(diagnostics.some(event => event.event === 'ws_response_protocol_anomaly')).toBe(false);
  });

  it('detects a late delta for a reasoning part the SDK has already concluded', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify({ store: false }),
    });
    const socket = lastSocket();
    const events = [
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-late' },
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-late',
        summary_index: 0, delta: 'first',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-late', summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_part.added', item_id: 'reasoning-late', summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-late',
        summary_index: 0, delta: 'late',
      },
      { type: 'response.failed', response: { id: 'resp_late', status: 'failed' } },
    ];
    for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_protocol_anomaly',
      anomaly: 'reasoning_start_missing_before_delta',
      summaryIndex: 0,
      knownSummaryParts: [
        { summaryIndex: 0, state: 'concluded' },
        { summaryIndex: 1, state: 'active' },
      ],
      recentUpstreamEventTypes: [
        'response.output_item.added',
        'response.reasoning_summary_text.delta',
        'response.reasoning_summary_part.done',
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_text.delta',
      ],
    }));
  });

  it('closes the socket when the request is aborted', async () => {
    const controller = new AbortController();
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}', signal: controller.signal });
    const socket = lastSocket();
    controller.abort();
    await readAll(res);
    expect(socket.close).toHaveBeenCalled();
  });

  it('retains one socket and sends only append-only input with current prompt fields', async () => {
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai', accountId: 'acct-1',
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_1', 'hi');
    await readAll(first);

    expect(socket.close).not.toHaveBeenCalled();

    // A newly-created provider/fetch closure must still find the process-level chain.
    const nextFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai', accountId: 'acct-1',
    });
    const echoedAssistant = { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] };
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'again' }] };
    const updatedTools = [
      { type: 'function', name: 'Read', parameters: { type: 'object' } },
      { type: 'function', name: 'Write', parameters: { type: 'object' } },
    ];
    const second = await nextFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...firstInput, echoedAssistant, nextUser], {
        instructions: 'You are a coding assistant. A skill is now active.',
        tools: updatedTools,
      })),
    });

    expect(fakeSockets).toHaveLength(1);
    expect(socket.send).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_1');
    expect(sent.input).toEqual([nextUser]);
    expect(sent.instructions).toBe('You are a coding assistant. A skill is now active.');
    expect(sent.tools).toEqual(updatedTools);

    emitTextResponse(socket, 'resp_2', 'hello again');
    await readAll(second);
  });

  it('keeps upstream frames byte-identical when native compaction is disabled', async () => {
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compaction-disabled',
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Preserve the default path.' }],
    };
    const firstPayload = sessionPayload([firstUser]);
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 999_999 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(firstPayload),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    expect(socket.send.mock.calls[0]![0]).toBe(JSON.stringify({
      type: 'response.create',
      ...firstPayload,
    }));
    emitTextResponse(socket, 'resp_disabled_base', 'Default answer.', {
      input_tokens: 999_999,
      output_tokens: 10,
    });
    await readAll(first);

    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Default answer.' }],
    };
    const compactInstruction = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Create the normal portable summary.' }],
    };
    const secondPayload = sessionPayload([firstUser, assistant, compactInstruction]);
    const second = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 999_999, forceCompaction: true },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(secondPayload),
      }),
    );
    expect(socket.send.mock.calls[1]![0]).toBe(JSON.stringify({
      type: 'response.create',
      ...secondPayload,
      input: [compactInstruction],
      previous_response_id: 'resp_disabled_base',
    }));
    expect(compactFetch).not.toHaveBeenCalled();
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(
      socket,
      'resp_disabled_summary',
      '<summary>The default summary remains unchanged.</summary>',
    );
    await readAll(second);
  });

  it('never triggers compaction without new incremental input', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-empty-delta',
      compactThreshold: 100,
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_empty_delta_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const sameHistory = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ];
    const repeated = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(sameHistory)),
    });
    expect(originalSocket.send).toHaveBeenCalledOnce();
    const replacement = lastSocket();
    expect(replacement).not.toBe(originalSocket);
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.input).toEqual(sameHistory);
    expect(sent.input).not.toContainEqual({ type: 'compaction_trigger' });
    emitTextResponse(replacement, 'resp_empty_delta_repeated', 'done');
    await readAll(repeated);
  });

  it('compacts once at the measured threshold, starts a fresh chain, then resumes delta-only', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const canonical = [{ type: 'compaction', encrypted_content: 'opaque-summary' }];
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'acct-native-compact',
      compactThreshold: 900,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_before_compact', 'first answer', {
      input_tokens: 950,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens: 20,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = { role: 'user', content: [{ type: 'input_text', text: 'second' }] };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify(sessionPayload(secondInput)),
    });

    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    const trigger = JSON.parse(originalSocket.send.mock.calls[1]![0] as string);
    expect(trigger.previous_response_id).toBe('resp_before_compact');
    expect(trigger.input).toEqual([secondUser, { type: 'compaction_trigger' }]);
    emitCompactionResponse(originalSocket, 'resp_compaction_trigger', 'opaque-summary', {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 950, cache_write_tokens: 25 },
      output_tokens: 25,
    });
    const second = await secondPromise;
    expect(compactFetch).not.toHaveBeenCalled();

    expect(fakeSockets).toHaveLength(2);
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    const compactedHead = JSON.parse(compactedSocket.send.mock.calls[0]![0] as string);
    expect(compactedHead.previous_response_id).toBeUndefined();
    expect(compactedHead.input).toEqual([firstUser, secondUser, ...canonical]);
    emitTextResponse(compactedSocket, 'resp_compacted', 'second answer', {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 75 },
      output_tokens: 20,
    });
    await readAll(second);
    expect(originalSocket.close).toHaveBeenCalledOnce();

    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    const thirdUser = { role: 'user', content: [{ type: 'input_text', text: 'third' }] };
    const third = await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });
    expect(compactFetch).not.toHaveBeenCalled();
    expect(fakeSockets).toHaveLength(2);
    const continued = JSON.parse(compactedSocket.send.mock.calls[1]![0] as string);
    expect(continued.previous_response_id).toBe('resp_compacted');
    expect(continued.input).toEqual([thirdUser]);
    compactedSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'previous_response_not_found', message: 'compacted head expired' },
    })));
    expect(fakeSockets).toHaveLength(3);
    const restoredSocket = lastSocket();
    restoredSocket.emit('open');
    const restored = JSON.parse(restoredSocket.send.mock.calls[0]![0] as string);
    expect(restored.previous_response_id).toBeUndefined();
    expect(restored.input).toEqual([
      firstUser,
      secondUser,
      ...canonical,
      secondAssistant,
      thirdUser,
    ]);
    emitTextResponse(restoredSocket, 'resp_after_compact', 'third answer');
    await readAll(third);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'started',
      reason: 'measured_threshold',
      transport: 'previous_response_compaction_trigger',
      sourceItems: secondInput.length,
      incrementalItems: 1,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'completed',
      reason: 'measured_threshold',
      threshold: 900,
      transport: 'previous_response_compaction_trigger',
      inputTokens: 1_000,
      cachedTokens: 950,
      cacheWriteTokens: 25,
      outputTokens: 25,
      durationMs: expect.any(Number),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_head_decision',
      decision: 'compaction_trigger_new_head',
      compactThreshold: 900,
    }));
  });

  it('returns a synthetic Claude summary and re-anchors it to native compacted state', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(
      process.env.CLODEX_HOME!,
      'claude-summary-anchor-checkpoints-',
    ));
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const compactFetch = vi.fn();
    const options = {
      accountId: 'acct-claude-summary-anchor',
      compactThreshold: 900,
      contextWindow: 2_000,
      checkpointStoreDir,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    };
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, options);
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Investigate the original task.' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_anchor_base', 'Original answer.', {
      input_tokens: 950,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Original answer.' }],
    };
    const secondUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Continue the original task.' }],
    };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(secondInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_anchor_trigger', 'opaque-anchor');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_anchor_compacted', 'Second answer.', {
      input_tokens: 120,
      output_tokens: 10,
    });
    await readAll(second);
    expect(originalSocket.close).toHaveBeenCalledOnce();

    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Second answer.' }],
    };
    const compactInstruction = {
      role: 'user',
      content: [{
        type: 'input_text',
        text: 'Your task is to create a detailed summary of the conversation so far.',
      }],
    };
    const compactRequestInput = [
      {
        ...firstUser,
        content: [{ type: 'input_text', text: 'Investigate the original task. [resumed]' }],
      },
      ...secondInput.slice(1),
      secondAssistant,
      compactInstruction,
    ];
    const compactRequestPromise = withResponsesWebSocketDiagnosticContext(
      { forceCompaction: true },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(compactRequestInput)),
      }),
    );

    await waitForCondition(() => expect(compactedSocket.send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(compactedSocket.send.mock.calls[1]![0] as string)).toMatchObject({
      previous_response_id: 'resp_anchor_compacted',
      input: [compactInstruction, { type: 'compaction_trigger' }],
    });
    expect(compactFetch).not.toHaveBeenCalled();
    emitCompactionResponse(
      compactedSocket,
      'resp_anchor_manual_trigger',
      'opaque-manual-anchor',
      {
        input_tokens: 130,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens: 20,
      },
    );
    const compactRequest = await compactRequestPromise;
    const compactFrames = (await readAll(compactRequest))
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.replace(/^data: /, '')));
    const syntheticText = compactFrames
      .find(event => event.type === 'response.output_text.delta')?.delta as string;
    expect(syntheticText).toMatch(
      /^<summary>Context compacted natively by OpenAI and retained in Clodex checkpoint /,
    );
    expect(compactFrames.find(event => event.type === 'response.completed').response.usage)
      .toMatchObject({
        input_tokens: 130,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens: 20,
      });
    expect(fakeSockets).toHaveLength(2);
    const portableSummary = syntheticText.match(/<summary>([\s\S]*)<\/summary>/)![1]!;
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'synthetic_checkpoint',
      transport: 'claude_compaction_response',
      checkpointDurable: true,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_head_decision',
      decision: 'claude_compaction_checkpoint',
      continuationMatchMode: 'claude_compaction_request',
    }));

    const continuationPrefix =
      'This session is being continued from a previous conversation that ran out of context. '
      + 'The summary below covers the earlier portion of the conversation.\n\n';
    const continuationSuffix =
      'Continue the conversation from where it left off without asking the user any further questions. '
      + 'Resume directly — do not acknowledge the summary, do not recap what was happening, '
      + 'do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
    const currentPrompt = { type: 'input_text', text: 'Now implement the next change.' };
    const mismatchedUser = {
      role: 'user',
      content: [{
        type: 'input_text',
        text: `${continuationPrefix}Summary:\nA different portable summary must not select opaque state.`
          + `\n${continuationSuffix}`,
      }, currentPrompt],
    };
    const mismatched = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([mismatchedUser])),
    });
    const mismatchedSocket = lastSocket();
    mismatchedSocket.emit('open');
    const mismatchedSent = JSON.parse(mismatchedSocket.send.mock.calls[0]![0] as string);
    expect(mismatchedSent.previous_response_id).toBeUndefined();
    expect(mismatchedSent.input).toEqual([mismatchedUser]);
    emitTextResponse(mismatchedSocket, 'resp_anchor_mismatch', 'Safe fallback.');
    await readAll(mismatched);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'anchor_missed',
      envelopeCount: 1,
    }));

    const rewrittenUser = {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `${continuationPrefix}Summary:\n${portableSummary}`
            + '\n\nIf you need specific details from before compaction, consult the transcript.'
            + `\n${continuationSuffix}`,
        },
        currentPrompt,
      ],
    };
    const duplicatedUser = {
      ...rewrittenUser,
      content: [{
        type: 'input_text',
        text: `${rewrittenUser.content[0]!.text}\n${rewrittenUser.content[0]!.text}`,
      }, currentPrompt],
    };
    const duplicated = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([duplicatedUser])),
    });
    const duplicatedSocket = lastSocket();
    duplicatedSocket.emit('open');
    const duplicatedSent = JSON.parse(duplicatedSocket.send.mock.calls[0]![0] as string);
    expect(duplicatedSent.previous_response_id).toBeUndefined();
    expect(duplicatedSent.input).toEqual([duplicatedUser]);
    emitTextResponse(duplicatedSocket, 'resp_anchor_duplicated', 'Safe duplicate fallback.');
    await readAll(duplicated);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'anchor_missed',
      envelopeCount: 2,
    }));

    const continued = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([rewrittenUser])),
    });

    const anchoredSocket = lastSocket();
    anchoredSocket.emit('open');
    const sent = JSON.parse(anchoredSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'compaction' }),
      expect.objectContaining({ role: 'assistant' }),
      { role: 'user', content: [currentPrompt] },
    ]));
    expect(compactFetch).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'compaction_checkpoint',
      continuationMatchMode: 'claude_compaction_summary',
    });
    expect(JSON.stringify(diagnostics)).not.toContain(portableSummary);

    emitTextResponse(anchoredSocket, 'resp_anchor_continued', 'Implemented.', {
      input_tokens: 1_200,
      output_tokens: 10,
    });
    await readAll(continued);

    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const resumedFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      ...options,
      compactThreshold: 1_500,
      contextWindow: 2_500,
    });
    const durableResume = await resumedFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([rewrittenUser])),
    });
    const durableSocket = lastSocket();
    durableSocket.emit('open');
    expect(JSON.parse(durableSocket.send.mock.calls[0]![0] as string).input).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'compaction' })]),
    );
    emitTextResponse(durableSocket, 'resp_durable_anchor', 'Still anchored.', {
      input_tokens: 1_200,
      output_tokens: 10,
    });
    await readAll(durableResume);

    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const handoffFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      ...options,
      compactThreshold: 1_500,
      contextWindow: 4_000,
    });

    const compactBodies: unknown[][] = [];
    compactFetch.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      compactBodies.push(body.input);
      return new Response(JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'account-handoff-rebase' }],
        usage: { input_tokens: 850, output_tokens: 20 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const staleAccountHistory = {
      role: 'user',
      content: [{ type: 'input_text', text: `stale-account:${'x'.repeat(8_000)}` }],
    };
    const retainedTurns = Array.from({ length: 6 }, (_, index) => ([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `retained-${index}:${'a'.repeat(600)}` }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `current-${index}:${'u'.repeat(300)}` }],
      },
    ])).flat();
    const retainedUser = retainedTurns.at(-1)!;
    const handedOff = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 4_300, claudeAgentId: 'account-handoff-resume' },
      () => handoffFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          staleAccountHistory,
          rewrittenUser,
          ...retainedTurns,
        ])),
      }),
    );

    expect(compactBodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(compactBodies)).not.toContain('stale-account:');
    const handedOffSocket = lastSocket();
    handedOffSocket.emit('open');
    const handedOffPayload = JSON.parse(handedOffSocket.send.mock.calls[0]![0] as string);
    expect(handedOffPayload.previous_response_id).toBeUndefined();
    expect(handedOffPayload.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'compaction', encrypted_content: 'account-handoff-rebase' }),
      retainedUser,
    ]));
    emitTextResponse(handedOffSocket, 'resp_account_handoff', 'Resumed safely.');
    await readAll(handedOff);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_overflow_recovery',
      outcome: 'stage_accepted',
      reason: 'known_oversized',
    }));
    rmSync(checkpointStoreDir, { recursive: true, force: true });
  });

  it('does not anchor a tampered synthetic Claude compaction summary', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-short-summary',
      compactThreshold: 100,
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_short_summary_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    };
    const secondUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'second' }],
    };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(secondInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_short_summary_trigger', 'short-anchor');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_short_summary_compacted', 'second answer');
    await readAll(second);

    const compactInstruction = {
      role: 'user',
      content: [{ type: 'input_text', text: 'Create a portable summary.' }],
    };
    const compactRequestPromise = withResponsesWebSocketDiagnosticContext(
      { forceCompaction: true },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          ...secondInput,
          { role: 'assistant', content: [{ type: 'output_text', text: 'second answer' }] },
          compactInstruction,
        ])),
      }),
    );
    await waitForCondition(() => expect(compactedSocket.send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(compactedSocket.send.mock.calls[1]![0] as string).input)
      .toEqual([compactInstruction, { type: 'compaction_trigger' }]);
    emitCompactionResponse(
      compactedSocket,
      'resp_short_summary_manual_trigger',
      'short-manual-anchor',
    );
    const compactRequest = await compactRequestPromise;
    expect(await readAll(compactRequest)).toContain('Context compacted natively by OpenAI');
    expect(lastSocket()).toBe(compactedSocket);

    const continuationPrefix =
      'This session is being continued from a previous conversation that ran out of context. '
      + 'The summary below covers the earlier portion of the conversation.\n\n';
    const continuationSuffix =
      'Continue the conversation from where it left off without asking the user any further questions. '
      + 'Resume directly — do not acknowledge the summary, do not recap what was happening, '
      + 'do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
    const rewrittenUser = {
      role: 'user',
      content: [{
        type: 'input_text',
        text: `${continuationPrefix}Summary:\nx\n${continuationSuffix}`,
      }, {
        type: 'input_text',
        text: 'continue',
      }],
    };
    const continued = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([rewrittenUser])),
    });
    const fallbackSocket = lastSocket();
    expect(fallbackSocket).not.toBe(compactedSocket);
    fallbackSocket.emit('open');
    const sent = JSON.parse(fallbackSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual([rewrittenUser]);
    emitTextResponse(fallbackSocket, 'resp_short_summary_fallback', 'done');
    await readAll(continued);
  });

  it.each([
    { label: 'parent orchestrator', claudeAgentId: undefined, prefix: [] as unknown[] },
    { label: 'ordinary subagent', claudeAgentId: 'subagent-compact', prefix: [] as unknown[] },
    {
      label: 'dynamic workflow agent',
      claudeAgentId: 'workflow-compact',
      prefix: [{
        role: 'developer',
        content: [{ type: 'input_text', text: 'workflow phase context' }],
      }] as unknown[],
    },
  ])(
    'restores $label synthetic compact checkpoint and token reporting after restart',
    async ({ label, claudeAgentId, prefix }) => {
      mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
      const checkpointStoreDir = mkdtempSync(
        join(process.env.CLODEX_HOME!, `synthetic-${label.replaceAll(' ', '-')}-`),
      );
      const compactInstruction = {
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Your task is to create a detailed summary of the conversation so far.',
        }],
      };
      const canonical = [
        { type: 'compaction', encrypted_content: `opaque-${label}` },
      ];
      const compactFetch = vi.fn(async () => new Response(JSON.stringify({
        output: canonical,
        usage: {
          input_tokens: 210,
          input_tokens_details: { cached_tokens: 180, cache_write_tokens: 4 },
          output_tokens: 18,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      const accountId = `acct-synthetic-${label.replaceAll(' ', '-')}`;
      const compactingFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId,
        compactThreshold: 100,
        compactFetch: compactFetch as typeof fetch,
        checkpointStoreDir,
      });
      const compactResponse = await withResponsesWebSocketDiagnosticContext(
        { claudeAgentId, forceCompaction: true },
        () => compactingFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([...prefix, compactInstruction])),
        }),
      );
      const compactEvents = (await readAll(compactResponse))
        .split('\n\n')
        .filter(Boolean)
        .map(frame => JSON.parse(frame.replace(/^data: /, '')));
      const summaryText = compactEvents
        .find(event => event.type === 'response.output_text.delta').delta as string;
      const summaryBody = summaryText.match(/<summary>([\s\S]*)<\/summary>/)![1]!;
      expect(compactEvents.find(event => event.type === 'response.completed').response.usage)
        .toMatchObject({
          input_tokens: 210,
          input_tokens_details: { cached_tokens: 180, cache_write_tokens: 4 },
          output_tokens: 18,
        });
      expect(fakeSockets).toHaveLength(0);
      expect(readdirSync(checkpointStoreDir)).toHaveLength(1);

      resetResponsesWebSocketConnectionsForTests();
      fakeSockets.length = 0;
      const compactAfterRestart = vi.fn();
      const resumedFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId,
        compactThreshold: 100,
        compactFetch: compactAfterRestart as typeof fetch,
        checkpointStoreDir,
      });
      const continuationPrefix =
        'This session is being continued from a previous conversation that ran out of context. '
        + 'The summary below covers the earlier portion of the conversation.\n\n';
      const continuationSuffix =
        'Continue the conversation from where it left off without asking the user any further questions. '
        + 'Resume directly — do not acknowledge the summary, do not recap what was happening, '
        + 'do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
      const nextPrompt = { type: 'input_text', text: `${label} next turn` };
      const rewrittenUser = {
        role: 'user',
        content: [{
          type: 'input_text',
          text: `${continuationPrefix}Summary:\n${summaryBody}\n${continuationSuffix}`,
        }, nextPrompt],
      };
      const resumed = await withResponsesWebSocketDiagnosticContext(
        { claudeAgentId },
        () => resumedFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([rewrittenUser])),
        }),
      );
      const socket = lastSocket();
      socket.emit('open');
      const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
      expect(sent.previous_response_id).toBeUndefined();
      expect(sent.input).toEqual(expect.arrayContaining([
        canonical[0],
        expect.objectContaining({ role: 'assistant' }),
        { role: 'user', content: [nextPrompt] },
      ]));
      emitTextResponse(socket, `resp_${label}`, `${label} continued`, {
        input_tokens: 50,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 7,
      });
      const completed = (await readAll(resumed))
        .split('\n\n')
        .filter(Boolean)
        .map(frame => JSON.parse(frame.replace(/^data: /, '')))
        .find(event => event.type === 'response.completed');
      expect(completed.response.usage).toMatchObject({
        input_tokens: 50,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 7,
      });
      expect(compactAfterRestart).not.toHaveBeenCalled();
    },
  );

  it('bounds retained user messages to the Codex 64K policy during a native rebase', async () => {
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-retention-budget',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const hugeUser = {
      role: 'user',
      content: [{ type: 'input_text', text: `begin-${'old-context-'.repeat(30_000)}-end` }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([hugeUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_retention_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const latestUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'preserve this latest request exactly' }],
    };
    const fullInput = [
      hugeUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      latestUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_retention_trigger', 'bounded-summary');
    const second = await secondPromise;

    const rebasedSocket = lastSocket();
    rebasedSocket.emit('open');
    const rebased = JSON.parse(rebasedSocket.send.mock.calls[0]![0] as string);
    expect(rebased.input).toHaveLength(3);
    expect(rebased.input[1]).toEqual(latestUser);
    expect(rebased.input[2]).toEqual({
      type: 'compaction',
      encrypted_content: 'bounded-summary',
    });
    const truncatedText = rebased.input[0].content[0].text as string;
    expect(truncatedText).toContain('retained text truncated');
    expect(truncatedText.length).toBeLessThan(hugeUser.content[0]!.text.length);
    expect(JSON.stringify(rebased.input.slice(0, 2)).length).toBeLessThan(260_000);
    expect(compactFetch).not.toHaveBeenCalled();
    emitTextResponse(rebasedSocket, 'resp_retention_done', 'done');
    await readAll(second);
  });

  it('budgets retained images as vision input instead of base64 text', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-image-budget',
      compactThreshold: 100,
    });
    const imagePart = {
      type: 'input_image',
      image_url: `data:image/png;base64,${'a'.repeat(250_000)}`,
    };
    const hugeUser = {
      role: 'user',
      content: [
        imagePart,
        { type: 'input_text', text: `begin-${'x'.repeat(300_000)}-end` },
      ],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([hugeUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_image_budget_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const latestUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'keep the image-aware budget' }],
    };
    const fullInput = [
      hugeUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      latestUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(fullInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_image_budget_trigger', 'image-summary');
    const second = await secondPromise;
    const rebasedSocket = lastSocket();
    rebasedSocket.emit('open');
    const rebased = JSON.parse(rebasedSocket.send.mock.calls[0]![0] as string);
    expect(rebased.input[0].content[0]).toEqual(imagePart);
    const retainedText = rebased.input[0].content[1].text as string;
    expect(Buffer.byteLength(retainedText, 'utf8')).toBeGreaterThan(240_000);
    expect(Buffer.byteLength(retainedText, 'utf8')).toBeLessThanOrEqual(250_000);
    emitTextResponse(rebasedSocket, 'resp_image_budget_done', 'done');
    await readAll(second);
  });

  it('falls back to a normal full-context head when both native compaction routes are unavailable', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'private compact failure' },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-fallback',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_fallback_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      nextUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });

    await waitForCondition(() => expect(socket.send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(socket.send.mock.calls[1]![0] as string)).toMatchObject({
      previous_response_id: 'resp_fallback_base',
      input: [nextUser, { type: 'compaction_trigger' }],
    });
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'compaction_trigger_unavailable', message: 'private trigger failure' },
    })));
    const second = await secondPromise;
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(fullInput);
    emitTextResponse(replacement, 'resp_fallback_next', 'done');
    await readAll(second);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'previous_response_compaction_trigger',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'responses_compact_endpoint',
      statusCode: 503,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private compact failure');
    expect(JSON.stringify(diagnostics)).not.toContain('private trigger failure');
  });

  it('times out an in-band trigger before the downstream watchdog and falls back', async () => {
    const canonical = [
      { role: 'user', content: [{ type: 'input_text', text: 'retained after timeout' }] },
      { type: 'compaction', encrypted_content: 'timeout-summary' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: canonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-trigger-timeout',
      compactThreshold: 100,
      compactTimeoutMs: 5,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_timeout_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'next' }],
    };
    const second = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        firstUser,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        nextUser,
      ])),
    });
    expect(originalSocket.close).toHaveBeenCalledOnce();
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'fallback',
      transport: 'previous_response_compaction_trigger',
      errorType: 'ResponsesCompactionError',
    }));

    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]![0] as string).input).toEqual(canonical);
    emitTextResponse(replacement, 'resp_timeout_recovered', 'done');
    await readAll(second);
  });

  it.each(['response.failed', 'response.incomplete'] as const)(
    'uses standalone compact output and retains usage when a live trigger ends with %s',
    async terminalType => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const canonical = [
      { role: 'user', content: [{ type: 'input_text', text: 'retained' }] },
      { type: 'compaction_summary', encrypted_content: 'endpoint-summary' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: canonical,
      usage: {
        input_tokens: 200,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 30,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: `acct-compact-endpoint-fallback-${terminalType}`,
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_endpoint_fallback_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    originalSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created',
      response: { id: `resp_endpoint_fallback_${terminalType}` },
    })));
    originalSocket.emit('message', Buffer.from(JSON.stringify({
      type: terminalType,
      response: {
        id: `resp_endpoint_fallback_${terminalType}`,
        status: terminalType === 'response.failed' ? 'failed' : 'incomplete',
        usage: {
          input_tokens: 80,
          input_tokens_details: { cached_tokens: 70, cache_write_tokens: 2 },
          output_tokens: 5,
        },
        ...(terminalType === 'response.failed'
          ? { error: { code: 'server_error', message: 'trigger failed after usage' } }
          : { incomplete_details: { reason: 'max_output_tokens' } }),
      },
    })));

    const second = await secondPromise;
    expect(compactFetch).toHaveBeenCalledOnce();
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(canonical);
    emitTextResponse(replacement, 'resp_endpoint_fallback_next', 'done', {
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
      output_tokens: 10,
    });
    const events = (await readAll(second))
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.replace(/^data: /, '')));
    const completed = events.find(event => event.type === 'response.completed');
    expect(completed.response.usage).toMatchObject({
      input_tokens: 330,
      output_tokens: 45,
      total_tokens: 375,
      input_tokens_details: {
        cached_tokens: 110,
        cache_write_tokens: 5,
      },
    });
    expect(originalSocket.close).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_compaction',
      outcome: 'completed',
      transport: 'responses_compact_endpoint',
      inputTokens: 200,
      outputTokens: 30,
    }));
    },
  );

  it('recompacts canonical opaque state when an in-band trigger falls back to HTTP', async () => {
    const firstCanonical = [{ type: 'compaction', encrypted_content: 'first-opaque-state' }];
    const secondCanonical = [{ type: 'compaction', encrypted_content: 'second-opaque-state' }];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toEqual([
        firstUser,
        secondUser,
        ...firstCanonical,
        secondAssistant,
        thirdUser,
      ]);
      return new Response(JSON.stringify({ output: secondCanonical }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-recompact-http-fallback',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_recompact_base', 'first answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = { role: 'user', content: [{ type: 'input_text', text: 'second' }] };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_recompact_first_trigger', 'first-opaque-state');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    emitTextResponse(compactedSocket, 'resp_recompact_first_head', 'second answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(second);

    const thirdUser = { role: 'user', content: [{ type: 'input_text', text: 'third' }] };
    const thirdPromise = wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });
    await waitForCondition(() => expect(compactedSocket.send).toHaveBeenCalledTimes(2));
    compactedSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'compaction_trigger_unavailable', message: 'trigger unavailable' },
    })));
    const third = await thirdPromise;

    expect(compactFetch).toHaveBeenCalledOnce();
    const recompactedSocket = lastSocket();
    recompactedSocket.emit('open');
    const sent = JSON.parse(recompactedSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(secondCanonical);
    emitTextResponse(recompactedSocket, 'resp_recompact_second_head', 'third answer');
    await readAll(third);
    expect(compactedSocket.close).toHaveBeenCalledOnce();
  });

  it('retries a compacted fresh head with canonical compact input, not the full transcript', async () => {
    const canonical = [{ type: 'compaction', encrypted_content: 'retry-summary' }];
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-retry',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_retry_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      nextUser,
    ];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_retry_trigger', 'retry-summary');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    const compactedInput = [firstUser, nextUser, ...canonical];
    expect(JSON.parse(compactedSocket.send.mock.calls[0]![0] as string).input)
      .toEqual(compactedInput);

    compactedSocket.emit(
      'error',
      Object.assign(new Error('compacted transport failure'), { code: 'ECONNRESET' }),
    );
    const replacement = lastSocket();
    replacement.emit('open');
    const replay = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(replay.previous_response_id).toBeUndefined();
    expect(replay.input).toEqual(compactedInput);
    expect(replay.input).not.toEqual(fullInput);
    emitTextResponse(replacement, 'resp_compact_retry', 'recovered');
    await readAll(second);
    expect(compactFetch).not.toHaveBeenCalled();
  });

  it('retries compaction after a post-compact failure and recovers after success', async () => {
    const retryCanonical = [{
      type: 'compaction',
      encrypted_content: 'retry-loop-summary',
    }];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: retryCanonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-failure-loop',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const fetchWithEstimate = (input: unknown[], estimatedInputTokens: number) =>
      withResponsesWebSocketDiagnosticContext(
        { estimatedInputTokens },
        () => wsFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload(input)),
        }),
      );
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const first = await fetchWithEstimate([firstUser], 50);
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_failure_loop_base', 'answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const fullInput = [
      firstUser,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ];
    const secondPromise = fetchWithEstimate(fullInput, 150);
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_failure_loop_trigger', 'loop-summary');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    compactedSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_failure_loop_failed',
        error: { code: 'server_error', message: 'post-compact turn failed' },
      },
    })));
    await readAll(second);

    const retry = await fetchWithEstimate(fullInput, 150);
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(compactFetch.mock.calls[0]![1]?.body)).input).toEqual(fullInput);
    expect(originalSocket.send).toHaveBeenCalledTimes(2);
    const retrySocket = lastSocket();
    retrySocket.emit('open');
    const retryFrame = JSON.parse(retrySocket.send.mock.calls[0]![0] as string);
    expect(retryFrame.previous_response_id).toBeUndefined();
    expect(retryFrame.input).toEqual(retryCanonical);
    emitTextResponse(retrySocket, 'resp_failure_loop_recovered', 'done', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(retry);

    const finalUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'after recovery' }],
    };
    const recoveredInput = [
      ...fullInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      finalUser,
    ];
    const recovered = await fetchWithEstimate(recoveredInput, 150);
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(retrySocket.send).toHaveBeenCalledTimes(2);
    const recoveredFrame = JSON.parse(retrySocket.send.mock.calls[1]![0] as string);
    expect(recoveredFrame.previous_response_id).toBe('resp_failure_loop_recovered');
    expect(recoveredFrame.input).toEqual([finalUser]);
    emitTextResponse(retrySocket, 'resp_failure_loop_done', 'fully recovered');
    await readAll(recovered);
  });

  it('restores a compact checkpoint after every matching live head has closed', async () => {
    const canonical = [{ type: 'compaction', encrypted_content: 'checkpoint-summary' }];
    const compactFetch = vi.fn();
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-checkpoint',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const firstUser = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([firstUser])),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_checkpoint_base', 'first answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = { role: 'user', content: [{ type: 'input_text', text: 'second' }] };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const secondPromise = wsFetch('https://example.test/responses', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    await waitForCondition(() => expect(originalSocket.send).toHaveBeenCalledTimes(2));
    emitCompactionResponse(originalSocket, 'resp_checkpoint_trigger', 'checkpoint-summary');
    const second = await secondPromise;
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_checkpoint_compact', 'second answer', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(second);

    originalSocket.emit('close', 1000, Buffer.from(''));
    compactedSocket.emit('close', 1000, Buffer.from(''));
    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    const thirdUser = { role: 'user', content: [{ type: 'input_text', text: 'third' }] };
    await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });

    const restoredSocket = lastSocket();
    restoredSocket.emit('open');
    const restored = JSON.parse(restoredSocket.send.mock.calls[0]![0] as string);
    expect(restored.previous_response_id).toBeUndefined();
    expect(restored.input).toEqual([
      firstUser,
      secondUser,
      ...canonical,
      secondAssistant,
      thirdUser,
    ]);
    expect(compactFetch).not.toHaveBeenCalled();
  });

  it('restores an oversized compacted session after the transport process restarts', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(process.env.CLODEX_HOME!, 'restart-checkpoints-'));
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const oldTurns = Array.from({ length: 1_625 }, (_, index) => ({
      role: 'user',
      content: [{
        type: 'input_text',
        text: `historical turn ${index} ${'x'.repeat(1_800)}`,
      }],
    }));
    const retainedUser = oldTurns.at(-1)!;
    const compactedCanonical = [
      retainedUser,
      { type: 'compaction', encrypted_content: 'restart-safe-opaque-state' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: compactedCanonical,
      usage: {
        input_tokens: 260_000,
        input_tokens_details: { cached_tokens: 250_000 },
        output_tokens: 900,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const initialFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-restart-recovery',
      compactThreshold: 258_000,
      compactFetch: compactFetch as typeof fetch,
      checkpointStoreDir,
      onDiagnostic: event => diagnostics.push(event),
    });
    const initial = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 300_000 },
      () => initialFetch('https://example.test/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer access-token-before-restart' },
        body: JSON.stringify(sessionPayload(oldTurns, {
          instructions: 'MCP tools are ready.',
          tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
        })),
      }),
    );
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_before_restart', 'checkpointed answer', {
      input_tokens: 40_000,
      input_tokens_details: { cached_tokens: 35_000 },
      output_tokens: 250,
    });
    await readAll(initial);

    expect(compactFetch).toHaveBeenCalledOnce();
    const persistedFiles = readdirSync(checkpointStoreDir);
    expect(persistedFiles).toHaveLength(1);
    const persistedPath = join(checkpointStoreDir, persistedFiles[0]!);
    expect(statSync(checkpointStoreDir).mode & 0o777).toBe(0o700);
    expect(statSync(persistedPath).mode & 0o777).toBe(0o600);
    const persisted = readFileSync(persistedPath, 'utf8');
    expect(persisted).toContain('restart-safe-opaque-state');
    expect(persisted).not.toContain('historical turn 0 ');

    // Simulate a fresh Clodex process: all sockets and process-local heads are
    // gone, while the private durable checkpoint remains.
    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const compactAfterRestart = vi.fn(async () => {
      throw new Error('the oversized transcript must not reach standalone compact');
    });
    const resumedFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-restart-recovery',
      compactThreshold: 258_000,
      compactFetch: compactAfterRestart as typeof fetch,
      checkpointStoreDir,
      onDiagnostic: event => diagnostics.push(event),
    });
    const echoedAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'checkpointed answer' }],
    };
    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'continue after restart' }],
    };
    const oversizedResume = [...oldTurns, echoedAssistant, nextUser];
    const resumed = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 400_000 },
      () => resumedFetch('https://example.test/responses', {
        method: 'POST',
        // OAuth token rotation must not orphan a checkpoint for the same account.
        headers: { Authorization: 'Bearer access-token-after-restart' },
        body: JSON.stringify(sessionPayload(oversizedResume, {
          instructions: 'MCP tools are still starting.',
          tools: [],
        })),
      }),
    );
    const restoredSocket = lastSocket();
    restoredSocket.emit('open');
    const restoredPayload = JSON.parse(restoredSocket.send.mock.calls[0]![0] as string);
    expect(restoredPayload.previous_response_id).toBeUndefined();
    expect(restoredPayload.input).toEqual([
      ...compactedCanonical,
      echoedAssistant,
      nextUser,
    ]);
    expect(Buffer.byteLength(JSON.stringify(restoredPayload.input), 'utf8'))
      .toBeLessThan(Buffer.byteLength(JSON.stringify(oversizedResume), 'utf8') / 100);
    expect(compactAfterRestart).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_head_decision',
      decision: 'compaction_checkpoint',
      matchingCheckpointCount: 1,
    }));
    emitTextResponse(restoredSocket, 'resp_after_restart', 'recovered');
    await readAll(resumed);
  });

  it('adds hidden native-compaction usage to the visible response totals', async () => {
    const user = {
      role: 'user',
      content: [{ type: 'input_text', text: 'compact and report every token' }],
    };
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [user, { type: 'compaction', encrypted_content: 'usage-summary' }],
      usage: {
        input_tokens: 210,
        input_tokens_details: { cached_tokens: 180, cache_write_tokens: 12 },
        output_tokens: 18,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compaction-usage',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const response = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 150 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([user])),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_compaction_usage', 'done', {
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
      output_tokens: 11,
    });
    const events = (await readAll(response))
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.replace(/^data: /, '')));
    const completed = events.find(event => event.type === 'response.completed');
    expect(completed.response.usage).toMatchObject({
      input_tokens: 260,
      output_tokens: 29,
      total_tokens: 289,
      input_tokens_details: {
        cached_tokens: 220,
        cache_write_tokens: 15,
      },
    });
  });

  it('surfaces aggregated compaction usage through the real OpenAI AI SDK', async () => {
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'sdk-usage-summary' }],
      usage: {
        input_tokens: 210,
        input_tokens_details: { cached_tokens: 180, cache_write_tokens: 12 },
        output_tokens: 18,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-sdk-compaction-usage',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const provider = createOpenAI({ apiKey: 'test-only', fetch: wsFetch });
    const usagePromise = withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'workflow-sdk-usage', estimatedInputTokens: 150 },
      async () => {
        const streamed = streamText({
          model: provider.responses('gpt-5.6-sol'),
          prompt: 'report usage through the SDK',
          maxRetries: 0,
        });
        for await (const part of streamed.stream) {
          if (part.type === 'finish') return part.totalUsage;
        }
        throw new Error('AI SDK stream ended without a finish part');
      },
    );
    await waitForCondition(() => expect(fakeSockets).toHaveLength(1));
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_sdk_compaction_usage', 'done', {
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
      output_tokens: 11,
    });

    expect(await usagePromise).toMatchObject({
      inputTokens: 260,
      outputTokens: 29,
      totalTokens: 289,
      inputTokenDetails: {
        cacheReadTokens: 220,
        cacheWriteTokens: 15,
      },
    });
  });

  it.each([
    {
      label: 'parent orchestrator',
      diagnostic: {},
      prefix: [] as unknown[],
    },
    {
      label: 'ordinary subagent',
      diagnostic: { claudeAgentId: 'subagent-1' },
      prefix: [] as unknown[],
    },
    {
      label: 'dynamic workflow agent',
      diagnostic: { claudeAgentId: 'workflow-agent-1' },
      prefix: [{
        role: 'developer',
        content: [{ type: 'input_text', text: 'workflow phase one' }],
      }] as unknown[],
    },
  ])(
    'keeps $label token reporting correct across native compaction and continuation',
    async ({ label, diagnostic, prefix }) => {
      const rootUser = {
        role: 'user',
        content: [{ type: 'input_text', text: `${label} root` }],
      };
      const root = [...prefix, rootUser];
      const compactFetch = vi.fn(async () => new Response(JSON.stringify({
        output: [
          rootUser,
          { type: 'compaction', encrypted_content: `${label}-opaque-state` },
        ],
        usage: {
          input_tokens: 210,
          input_tokens_details: { cached_tokens: 180, cache_write_tokens: 12 },
          output_tokens: 18,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: `acct-${label.replaceAll(' ', '-')}`,
        compactThreshold: 100,
        compactFetch: compactFetch as typeof fetch,
      });
      const first = await withResponsesWebSocketDiagnosticContext(
        { ...diagnostic, estimatedInputTokens: 150 },
        () => wsFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload(root)),
        }),
      );
      const socket = lastSocket();
      socket.emit('open');
      emitTextResponse(socket, `resp_${label}`, `${label} answer`, {
        input_tokens: 50,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
        output_tokens: 11,
      });
      const firstEvents = (await readAll(first))
        .split('\n\n')
        .filter(Boolean)
        .map(frame => JSON.parse(frame.replace(/^data: /, '')));
      expect(firstEvents.find(event => event.type === 'response.completed').response.usage)
        .toMatchObject({
          input_tokens: 260,
          output_tokens: 29,
          input_tokens_details: {
            cached_tokens: 220,
            cache_write_tokens: 15,
          },
        });

      const echoedAssistant = {
        role: 'assistant',
        content: [{ type: 'output_text', text: `${label} answer` }],
      };
      const nextUser = {
        role: 'user',
        content: [{ type: 'input_text', text: `${label} continue` }],
      };
      const second = await withResponsesWebSocketDiagnosticContext(
        diagnostic,
        () => wsFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([
            ...root,
            echoedAssistant,
            nextUser,
          ])),
        }),
      );
      const secondPayload = JSON.parse(socket.send.mock.calls[1]![0] as string);
      expect(secondPayload.previous_response_id).toBe(`resp_${label}`);
      expect(secondPayload.input).toEqual([nextUser]);
      emitTextResponse(socket, `resp_${label}_continued`, `${label} done`, {
        input_tokens: 60,
        input_tokens_details: { cached_tokens: 55, cache_write_tokens: 1 },
        output_tokens: 9,
      });
      const secondEvents = (await readAll(second))
        .split('\n\n')
        .filter(Boolean)
        .map(frame => JSON.parse(frame.replace(/^data: /, '')));
      expect(secondEvents.find(event => event.type === 'response.completed').response.usage)
        .toMatchObject({
          input_tokens: 60,
          output_tokens: 9,
          input_tokens_details: {
            cached_tokens: 55,
            cache_write_tokens: 1,
          },
        });
      expect(compactFetch).toHaveBeenCalledOnce();
    },
  );

  it('keeps an earlier agent checkpoint when its physical socket is recycled and compacted', async () => {
    const agentAUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'agent A root' }],
    };
    const agentACanonical = [
      agentAUser,
      { type: 'compaction', encrypted_content: 'agent-a-opaque-state' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: agentACanonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-recycled-checkpoints',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });

    const agentA = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-a', estimatedInputTokens: 150 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([agentAUser])),
      }),
    );
    const recycledSocket = lastSocket();
    recycledSocket.emit('open');
    emitTextResponse(recycledSocket, 'resp_agent_a', 'agent A answer', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(agentA);

    const agentBUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'agent B root' }],
    };
    const agentB = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-b', estimatedInputTokens: 10 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([agentBUser])),
      }),
    );
    expect(fakeSockets).toHaveLength(1);
    const agentBRootPayload = JSON.parse(recycledSocket.send.mock.calls[1]![0] as string);
    expect(agentBRootPayload.previous_response_id).toBeUndefined();
    emitTextResponse(recycledSocket, 'resp_agent_b', 'agent B answer', {
      input_tokens: 150,
      output_tokens: 10,
    });
    await readAll(agentB);

    const agentBAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'agent B answer' }],
    };
    const agentBNext = {
      role: 'user',
      content: [{ type: 'input_text', text: 'agent B continue' }],
    };
    const agentBCompactionPromise = withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-b' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          agentBUser,
          agentBAssistant,
          agentBNext,
        ])),
      }),
    );
    await waitForCondition(() => expect(recycledSocket.send).toHaveBeenCalledTimes(3));
    emitCompactionResponse(recycledSocket, 'resp_agent_b_trigger', 'agent-b-opaque-state');
    const agentBCompaction = await agentBCompactionPromise;
    const agentBCompactedSocket = lastSocket();
    agentBCompactedSocket.emit('open');
    emitTextResponse(agentBCompactedSocket, 'resp_agent_b_compacted', 'agent B done', {
      input_tokens: 40,
      output_tokens: 10,
    });
    await readAll(agentBCompaction);
    agentBCompactedSocket.emit('close', 1000, Buffer.from(''));

    const agentAAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'agent A answer' }],
    };
    const agentANext = {
      role: 'user',
      content: [{ type: 'input_text', text: 'agent A resume' }],
    };
    await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-a' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          agentAUser,
          agentAAssistant,
          agentANext,
        ])),
      }),
    );
    const restoredAgentASocket = lastSocket();
    restoredAgentASocket.emit('open');
    const restoredAgentA = JSON.parse(restoredAgentASocket.send.mock.calls[0]![0] as string);
    expect(restoredAgentA.previous_response_id).toBeUndefined();
    expect(restoredAgentA.input).toEqual([
      ...agentACanonical,
      agentAAssistant,
      agentANext,
    ]);
    expect(compactFetch).toHaveBeenCalledOnce();
  });

  it('continues a subagent tool loop and usage reporting after native compaction', async () => {
    const user = {
      role: 'user',
      content: [{ type: 'input_text', text: 'subagent run pwd' }],
    };
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [user, { type: 'compaction', encrypted_content: 'subagent-tool-state' }],
      usage: {
        input_tokens: 200,
        input_tokens_details: { cached_tokens: 180 },
        output_tokens: 10,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-subagent-tool-compaction',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
    });
    const first = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'subagent-tool', estimatedInputTokens: 150 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([user])),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    emitToolCallResponse(socket, 'resp_subagent_tool', 'call_pwd', {
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 5,
    });
    const firstCompleted = (await readAll(first))
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.replace(/^data: /, '')))
      .find(event => event.type === 'response.completed');
    expect(firstCompleted.response.usage).toMatchObject({
      input_tokens: 250,
      output_tokens: 15,
      input_tokens_details: { cached_tokens: 220 },
    });

    const echoedCall = {
      type: 'function_call',
      call_id: 'call_pwd',
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call_pwd',
      output: '/tmp/project',
    };
    const second = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'subagent-tool' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([user, echoedCall, toolOutput])),
      }),
    );
    const continued = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(continued.previous_response_id).toBe('resp_subagent_tool');
    expect(continued.input).toEqual([toolOutput]);
    emitTextResponse(socket, 'resp_subagent_tool_done', 'done', {
      input_tokens: 60,
      input_tokens_details: { cached_tokens: 55 },
      output_tokens: 6,
    });
    const secondCompleted = (await readAll(second))
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.replace(/^data: /, '')))
      .find(event => event.type === 'response.completed');
    expect(secondCompleted.response.usage).toMatchObject({
      input_tokens: 60,
      output_tokens: 6,
      input_tokens_details: { cached_tokens: 55 },
    });
    expect(compactFetch).toHaveBeenCalledOnce();
  });

  it('restores multiple workflow checkpoints after restart', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(process.env.CLODEX_HOME!, 'workflow-checkpoints-'));
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const lastUser = [...body.input].reverse().find(
        (item: { role?: string }) => item.role === 'user',
      );
      return new Response(JSON.stringify({
        output: [
          lastUser,
          {
            type: 'compaction',
            encrypted_content: `opaque-${lastUser.content[0].text}`,
          },
        ],
        usage: {
          input_tokens: 210,
          input_tokens_details: { cached_tokens: 180 },
          output_tokens: 18,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const workflowFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-workflow-restart',
      compactThreshold: 258_000,
      compactFetch: compactFetch as typeof fetch,
      checkpointStoreDir,
    });
    const roots = Array.from({ length: 16 }, (_, index) => [{
      role: 'user',
      content: [{ type: 'input_text', text: `workflow ${index}` }],
    }]);
    const firstWaveBodies: string[] = [];
    for (let index = 0; index < roots.length; index += 1) {
      const response = await withResponsesWebSocketDiagnosticContext(
        { claudeAgentId: `workflow-${index}`, estimatedInputTokens: 300_000 },
        () => workflowFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload(roots[index]!)),
        }),
      );
      const socket = lastSocket();
      socket.emit('open');
      emitTextResponse(socket, `resp_workflow_wave1_${index}`, `wave one ${index}`, {
        input_tokens: 40_000,
        input_tokens_details: { cached_tokens: 35_000 },
        output_tokens: 250,
      });
      firstWaveBodies.push(await readAll(response));
    }
    expect(fakeSockets).toHaveLength(roots.length);
    for (const body of firstWaveBodies) {
      const completed = body.split('\n\n')
        .filter(Boolean)
        .map(frame => JSON.parse(frame.replace(/^data: /, '')))
        .find(event => event.type === 'response.completed');
      expect(completed.response.usage).toMatchObject({
        input_tokens: 40_210,
        output_tokens: 268,
        input_tokens_details: { cached_tokens: 35_180 },
      });
    }
    expect(compactFetch).toHaveBeenCalledTimes(roots.length);
    expect(readdirSync(checkpointStoreDir)).toHaveLength(roots.length);

    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const compactAfterRestart = vi.fn();
    const resumedFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-workflow-restart',
      compactThreshold: 258_000,
      compactFetch: compactAfterRestart as typeof fetch,
      checkpointStoreDir,
    });
    const resumedBodies: string[] = [];
    for (let index = 0; index < roots.length; index += 1) {
      const assistant = {
        role: 'assistant',
        content: [{ type: 'output_text', text: `wave one ${index}` }],
      };
      const nextUser = {
        role: 'user',
        content: [{ type: 'input_text', text: `wave two ${index}` }],
      };
      const response = await withResponsesWebSocketDiagnosticContext(
        { claudeAgentId: `workflow-${index}`, estimatedInputTokens: 400_000 },
        () => resumedFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([
            ...roots[index]!,
            assistant,
            nextUser,
          ])),
        }),
      );
      const socket = lastSocket();
      socket.emit('open');
      const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
      expect(sent.previous_response_id).toBeUndefined();
      expect(sent.input).toEqual([
        roots[index]![0],
        {
          type: 'compaction',
          encrypted_content: `opaque-workflow ${index}`,
        },
        assistant,
        nextUser,
      ]);
      emitTextResponse(socket, `resp_workflow_wave2_${index}`, `wave two done ${index}`, {
        input_tokens: 60_000,
        input_tokens_details: { cached_tokens: 55_000 },
        output_tokens: 200,
      });
      resumedBodies.push(await readAll(response));
    }
    expect(fakeSockets).toHaveLength(roots.length);
    for (const body of resumedBodies) {
      const completed = body.split('\n\n')
        .filter(Boolean)
        .map(frame => JSON.parse(frame.replace(/^data: /, '')))
        .find(event => event.type === 'response.completed');
      expect(completed.response.usage).toMatchObject({
        input_tokens: 60_000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 55_000 },
      });
    }
    expect(compactAfterRestart).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'retries a failed checkpoint-store scan', initialStore: 'symlink', nextNow: 0 },
    { label: 'rescans for checkpoints written by another process', initialStore: 'empty', nextNow: 6_000 },
  ])('$label', async ({ initialStore, nextNow }) => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const target = mkdtempSync(join(process.env.CLODEX_HOME!, 'checkpoint-rescan-target-'));
    const checkpointStoreDir = initialStore === 'symlink'
      ? join(process.env.CLODEX_HOME!, `checkpoint-rescan-link-${randomUUID()}`)
      : target;
    if (initialStore === 'symlink') symlinkSync(target, checkpointStoreDir, 'dir');

    let now = 0;
    const accountId = `acct-checkpoint-rescan-${initialStore}`;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId,
      compactThreshold: 100,
      checkpointStoreDir,
      now: () => now,
    });
    const user = {
      role: 'user',
      content: [{ type: 'input_text', text: `initial ${initialStore}` }],
    };
    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'initial answer' }],
    };
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([user])),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, `resp_rescan_${initialStore}`, 'initial answer', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(first);
    firstSocket.emit('close', 1000, Buffer.from(''));

    if (initialStore === 'symlink') {
      rmSync(checkpointStoreDir);
      mkdirSync(checkpointStoreDir, { mode: 0o700 });
    }
    const checkpointKey = responsesWebSocketPartitionKey(
      WS_URL,
      sessionPayload([user]),
      { accountId },
    )!;
    const compactedInput = [
      user,
      { type: 'compaction', encrypted_content: `external-${initialStore}` },
    ];
    expect(saveStoredResponsesCheckpoint(checkpointStoreDir, {
      version: 2,
      checkpointKey,
      lineageKey: randomUUID(),
      requestInputHashes: [checkpointItemHash(user)],
      requestInputKinds: ['user'],
      expectedAssistantHashes: [checkpointItemHash(assistant)],
      expectedAssistantKinds: ['assistant'],
      compactedInput,
      lastInputTokens: 50,
      lastUsedAt: now,
    }, 16, 64)).toBe(true);

    now = nextNow;
    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'after external checkpoint' }],
    };
    const resumed = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([user, assistant, nextUser])),
    });
    const resumedSocket = lastSocket();
    resumedSocket.emit('open');
    const sent = JSON.parse(resumedSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual([...compactedInput, nextUser]);
    emitTextResponse(resumedSocket, `resp_rescan_done_${initialStore}`, 'done');
    await readAll(resumed);
  });

  it('restores a durable checkpoint when Claude reshapes opaque reasoning across old turns', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(process.env.CLODEX_HOME!, 'checkpoint-reasoning-replay-'));
    const accountId = 'acct-checkpoint-reasoning-replay';
    const user = { role: 'user', content: [{ type: 'input_text', text: 'start' }] };
    const oldReasoning = { type: 'reasoning', encrypted_content: 'old-request-reasoning', summary: [] };
    const call = {
      type: 'function_call', call_id: 'call_replay', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const output = { type: 'function_call_output', call_id: 'call_replay', output: '/tmp' };
    const oldAssistantReasoning = {
      type: 'reasoning', encrypted_content: 'old-assistant-reasoning', summary: [],
    };
    const assistant = {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
    };
    const requestInput = [user, oldReasoning, call, output];
    const expectedAssistant = [oldAssistantReasoning, assistant];
    const checkpointKey = responsesWebSocketPartitionKey(
      WS_URL,
      sessionPayload([user]),
      { accountId },
    )!;
    const compactedInput = [user, { type: 'compaction', encrypted_content: 'durable-native-state' }];
    expect(saveStoredResponsesCheckpoint(checkpointStoreDir, {
      version: 2,
      checkpointKey,
      lineageKey: randomUUID(),
      requestInputHashes: requestInput.map(checkpointItemHash),
      requestInputKinds: requestInput.map(item => (
        item && typeof item === 'object' && 'type' in item
          ? String(item.type)
          : String((item as { role?: unknown }).role)
      )),
      expectedAssistantHashes: expectedAssistant.map(checkpointItemHash),
      expectedAssistantKinds: expectedAssistant.map(item => String(item.type)),
      compactedInput,
      lastInputTokens: 260_000,
      lastUsedAt: Date.now(),
    }, 16, 64)).toBe(true);

    const compactFetch = vi.fn(async () => new Response('unexpected compaction', { status: 500 }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId,
      checkpointStoreDir,
      compactFetch,
      compactThreshold: 100,
    });
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'continue' }] };
    const replayedInput = [
      user,
      { type: 'reasoning', encrypted_content: 'reshaped-request-reasoning', summary: [{ text: 'new' }] },
      call,
      output,
      { type: 'reasoning', encrypted_content: 'reshaped-assistant-reasoning', summary: [] },
      assistant,
      nextUser,
    ];
    const response = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(replayedInput)),
    });
    const socket = lastSocket();
    socket.emit('open');
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual([...compactedInput, nextUser]);
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(compactFetch.mock.calls[0]![1]?.body)).input)
      .toEqual([...compactedInput, nextUser]);
    emitTextResponse(socket, 'resp_reasoning_replay_restored', 'continued', {
      input_tokens: 42_000,
      output_tokens: 100,
    });
    const body = await readAll(response);
    expect(body).toContain('response.completed');
    expect(body).toContain('42000');
  });

  it('does not restore durable checkpoints when native compaction is disabled', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(process.env.CLODEX_HOME!, 'checkpoint-disabled-'));
    const accountId = 'acct-checkpoint-disabled';
    const user = {
      role: 'user',
      content: [{ type: 'input_text', text: 'native compaction disabled' }],
    };
    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'prior answer' }],
    };
    const checkpointKey = responsesWebSocketPartitionKey(
      WS_URL,
      sessionPayload([user]),
      { accountId },
    )!;
    saveStoredResponsesCheckpoint(checkpointStoreDir, {
      version: 2,
      checkpointKey,
      lineageKey: randomUUID(),
      requestInputHashes: [checkpointItemHash(user)],
      requestInputKinds: ['user'],
      expectedAssistantHashes: [checkpointItemHash(assistant)],
      expectedAssistantKinds: ['assistant'],
      compactedInput: [{ type: 'compaction', encrypted_content: 'must-not-load' }],
      lastInputTokens: 300_000,
      lastUsedAt: Date.now(),
    }, 16, 64);

    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId,
      checkpointStoreDir,
    });
    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'continue without native state' }],
    };
    const fullInput = [user, assistant, nextUser];
    const response = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(fullInput)),
    });
    const socket = lastSocket();
    socket.emit('open');
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    expect(sent.input).toEqual(fullInput);
    expect(sent.input).not.toContainEqual(expect.objectContaining({
      encrypted_content: 'must-not-load',
    }));
    emitTextResponse(socket, 'resp_checkpoint_disabled', 'done');
    await readAll(response);
  });

  it('keeps newer in-memory checkpoint state when a periodic rescan finds stale disk state', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(process.env.CLODEX_HOME!, 'checkpoint-stale-rescan-'));
    let now = 10;
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'newer-memory-state' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const accountId = 'acct-checkpoint-stale-rescan';
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId,
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
      checkpointStoreDir,
      now: () => now,
    });
    const user = {
      role: 'user',
      content: [{ type: 'input_text', text: 'create newer checkpoint' }],
    };
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 150 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([user])),
      }),
    );
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_newer_checkpoint', 'newer answer', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(first);
    firstSocket.emit('close', 1000, Buffer.from(''));

    const [checkpointName] = readdirSync(checkpointStoreDir);
    const checkpointPath = join(checkpointStoreDir, checkpointName!);
    const stale = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    stale.lastUsedAt = 5;
    stale.compactedInput = [{ type: 'compaction', encrypted_content: 'stale-disk-state' }];
    writeFileSync(checkpointPath, JSON.stringify(stale), { mode: 0o600 });

    now = 6_010;
    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'newer answer' }],
    };
    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'continue from newer state' }],
    };
    const resumed = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([user, assistant, nextUser])),
    });
    const resumedSocket = lastSocket();
    resumedSocket.emit('open');
    const sent = JSON.parse(resumedSocket.send.mock.calls[0]![0] as string);
    expect(sent.input).toContainEqual(expect.objectContaining({
      encrypted_content: 'newer-memory-state',
    }));
    expect(sent.input).not.toContainEqual(expect.objectContaining({
      encrypted_content: 'stale-disk-state',
    }));
    emitTextResponse(resumedSocket, 'resp_newer_checkpoint_done', 'done');
    await readAll(resumed);
  });

  it('compacts oversized sibling workflow branches concurrently', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    let releaseCompactions!: () => void;
    const gate = new Promise<void>(resolve => { releaseCompactions = resolve; });
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await gate;
      const body = JSON.parse(String(init?.body));
      const user = body.input.at(-1);
      return new Response(JSON.stringify({
        output: [user, { type: 'compaction', encrypted_content: `opaque-${user.content[0].text}` }],
        usage: { input_tokens: 200, output_tokens: 10 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-concurrent-workflow-compaction',
      compactThreshold: 258_000,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const roots = ['sibling one', 'sibling two'].map(text => [{
      role: 'user',
      content: [{ type: 'input_text', text }],
    }]);
    const pending = roots.map((root, index) => withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: `sibling-${index}`, estimatedInputTokens: 300_000 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(root)),
      }),
    ));
    await waitForCondition(() => expect(compactFetch).toHaveBeenCalledTimes(2));
    releaseCompactions();
    const responses = await Promise.all(pending);

    expect(diagnostics.filter(
      event => event.event === 'ws_compaction'
        && event.outcome === 'completed'
        && event.transport === 'responses_compact_endpoint',
    )).toHaveLength(2);
    expect(diagnostics
      .filter(event => event.event === 'ws_head_decision')
      .map(event => event.decision))
      .toEqual(['compaction_new_head', 'compaction_new_head']);
    await Promise.all(responses.map(response => response.body?.cancel()));
  });

  it('expires process-local compact checkpoints after 30 minutes', async () => {
    let now = 0;
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const canonical = [
      firstUser,
      { type: 'compaction', encrypted_content: 'ttl-summary' },
    ];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: canonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-checkpoint-ttl',
      compactThreshold: 100,
      compactFetch: compactFetch as typeof fetch,
      now: () => now,
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 150 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([firstUser])),
      }),
    );
    const compactedSocket = lastSocket();
    compactedSocket.emit('open');
    emitTextResponse(compactedSocket, 'resp_checkpoint_ttl', 'answer', {
      input_tokens: 50,
      output_tokens: 10,
    });
    await readAll(first);
    compactedSocket.emit('close', 1000, Buffer.from(''));

    now = 30 * 60_000 + 1;
    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    };
    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'next' }],
    };
    const fullInput = [firstUser, assistant, nextUser];
    const second = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(fullInput)),
    });
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(fullInput);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_head_decision',
      evictions: expect.arrayContaining([
        expect.objectContaining({ reason: 'checkpoint_ttl' }),
      ]),
    }));
    emitTextResponse(replacement, 'resp_checkpoint_ttl_fallback', 'done');
    await readAll(second);
  });

  it('enforces both per-partition and global compact-checkpoint caps', async () => {
    async function exerciseCap(partitionKeys: string[]): Promise<{
      oldestInput: unknown[];
      newestInput: unknown[];
      oldestSummary: string;
      newestSummary: string;
    }> {
      let now = 0;
      const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const user = body.input[0];
        const label = user.content[0].text as string;
        return new Response(JSON.stringify({
          output: [user, { type: 'compaction', encrypted_content: `summary-${label}` }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: `acct-checkpoint-cap-${partitionKeys.length}`,
        compactThreshold: 100,
        compactFetch: compactFetch as typeof fetch,
        now: () => now,
      });
      const records: Array<{
        user: { role: string; content: Array<{ type: string; text: string }> };
        assistant: { role: string; content: Array<{ type: string; text: string }> };
        promptCacheKey: string;
        summary: string;
      }> = [];
      for (let index = 0; index < partitionKeys.length; index += 1) {
        now = index + 1;
        const label = `branch-${index}`;
        const user = {
          role: 'user',
          content: [{ type: 'input_text', text: label }],
        };
        const response = await withResponsesWebSocketDiagnosticContext(
          { estimatedInputTokens: 150 },
          () => wsFetch('https://example.test/responses', {
            method: 'POST',
            headers: {},
            body: JSON.stringify(sessionPayload([user], {
              prompt_cache_key: partitionKeys[index],
            })),
          }),
        );
        const socket = lastSocket();
        socket.emit('open');
        emitTextResponse(socket, `resp_cap_${index}`, `answer-${index}`, {
          input_tokens: 50,
          output_tokens: 10,
        });
        await readAll(response);
        socket.emit('close', 1000, Buffer.from(''));
        records.push({
          user,
          assistant: {
            role: 'assistant',
            content: [{ type: 'output_text', text: `answer-${index}` }],
          },
          promptCacheKey: partitionKeys[index]!,
          summary: `summary-${label}`,
        });
      }

      const requestBranch = async (
        record: typeof records[number],
        suffix: string,
      ): Promise<unknown[]> => {
        now += 1;
        const nextUser = {
          role: 'user',
          content: [{ type: 'input_text', text: suffix }],
        };
        const response = await wsFetch('https://example.test/responses', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([
            record.user,
            record.assistant,
            nextUser,
          ], {
            prompt_cache_key: record.promptCacheKey,
          })),
        });
        const socket = lastSocket();
        socket.emit('open');
        const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
        emitTextResponse(socket, `resp_${suffix}`, 'done');
        await readAll(response);
        return sent.input;
      };

      const oldest = records[0]!;
      const newest = records.at(-1)!;
      return {
        oldestInput: await requestBranch(oldest, 'oldest-next'),
        newestInput: await requestBranch(newest, 'newest-next'),
        oldestSummary: oldest.summary,
        newestSummary: newest.summary,
      };
    }

    const perPartition = await exerciseCap(Array.from({ length: 17 }, () => 'shared-key'));
    expect(perPartition.oldestInput).not.toContainEqual(expect.objectContaining({
      encrypted_content: perPartition.oldestSummary,
    }));
    expect(perPartition.newestInput).toContainEqual(expect.objectContaining({
      encrypted_content: perPartition.newestSummary,
    }));

    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const global = await exerciseCap(Array.from(
      { length: 257 },
      (_, index) => `partition-${index}`,
    ));
    expect(global.oldestInput).not.toContainEqual(expect.objectContaining({
      encrypted_content: global.oldestSummary,
    }));
    expect(global.newestInput).toContainEqual(expect.objectContaining({
      encrypted_content: global.newestSummary,
    }));
  });

  it('reuses a socket only while the authorization credential is unchanged', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'acct-token-rotation',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-a' },
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_token_a_1', 'first answer');
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'second' }],
    };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const second = await wsFetch('https://x', {
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer token-a' }),
      body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(firstSocket, 'resp_token_a_2', 'second answer');
    await readAll(second);

    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    const thirdUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'third' }],
    };
    const third = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-b' },
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });

    expect(fakeSockets).toHaveLength(2);
    const replacementSocket = lastSocket();
    expect(replacementSocket).not.toBe(firstSocket);
    expect(replacementSocket.options.headers?.Authorization).toBe('Bearer token-b');
    replacementSocket.emit('open');
    emitTextResponse(replacementSocket, 'resp_token_b_1', 'third answer');
    await readAll(third);
    expect(JSON.stringify(diagnostics)).not.toMatch(/token-[ab]/);
  });

  it('emits correlated privacy-safe reasons when a history mismatch creates another head', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'private-account-id',
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'private first prompt' }] }];
    const first = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-first' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
      }),
    );
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_first', 'private answer');
    await readAll(first);

    const branchInput = [{ role: 'user', content: [{ type: 'input_text', text: 'private divergent prompt' }] }];
    const branch = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-branch' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(branchInput)),
      }),
    );
    const branchSocket = lastSocket();
    branchSocket.emit('open');
    emitTextResponse(branchSocket, 'resp_branch', 'private branch answer');
    await readAll(branch);

    const firstDecision = diagnostics.find(event => event.requestId === 'req-first');
    const branchDecision = diagnostics.find(event => event.requestId === 'req-branch');
    expect(firstDecision).toMatchObject({
      event: 'ws_head_decision',
      decision: 'new_partition_head',
      candidateCount: 0,
      createdConnectionId: 1,
      keyTuple: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        effort: 'high',
        promptCacheKey: 'relay-session-abc',
        accountIdHash: expect.any(String),
      },
    });
    expect(branchDecision).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_new_head',
      candidateCount: 1,
      matchingCandidateCount: 0,
      createdConnectionId: 2,
      heads: [{
        connectionId: 1,
        mismatch: {
          firstMismatch: 0,
          expectedKind: 'user',
          actualKind: 'user',
          expectedHash: expect.any(String),
          actualHash: expect.any(String),
        },
      }],
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('private-account-id');
    expect(serialized).not.toContain('private first prompt');
    expect(serialized).not.toContain('private divergent prompt');
    expect(serialized).not.toContain('private answer');
    expect(serialized).not.toContain('private branch answer');
  });

  it('continues a tool loop with only the function_call_output', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'read it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-tools' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{ "path": "file.ts", "line": 1 }', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_tool' } })));
    await readAll(first);

    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read',
      arguments: '{"line":1,"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_tool');
    expect(sent.input).toEqual([toolOutput]);
    emitTextResponse(socket, 'resp_done', 'done');
    await readAll(second);
  });

  it('recycles a terminal subagent head for a later agent root', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-agent-recycle',
      onDiagnostic: event => diagnostics.push(event),
    });
    const root = [{ role: 'user', content: [{ type: 'input_text', text: 'agent A' }] }];
    const first = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-a' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(root)),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_agent_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_agent', call_id: 'call_agent', name: 'Bash', arguments: '{}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'function_call', id: 'fc_agent', call_id: 'call_agent', name: 'Bash',
        arguments: '{"command":"pwd"}', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_agent_tool' } })));
    await readAll(first);

    const call = {
      type: 'function_call', call_id: 'call_agent', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const result = { type: 'function_call_output', call_id: 'call_agent', output: '/tmp' };
    const terminal = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-a' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...root, call, result])),
      }),
    );
    emitTextResponse(socket, 'resp_agent_done', 'agent A done');
    await readAll(terminal);

    const secondRoot = [{ role: 'user', content: [{ type: 'input_text', text: 'agent B' }] }];
    const secondAgent = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-b' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondRoot)),
      }),
    );
    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(secondRoot);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_reused_head',
      selectedConnectionId: 1,
      selectedGeneration: 'established',
    });
    emitTextResponse(socket, 'resp_agent_b', 'agent B done');
    await readAll(secondAgent);

    const divergentSameAgent = [{ role: 'user', content: [{ type: 'input_text', text: 'agent B branch' }] }];
    const branch = await withResponsesWebSocketDiagnosticContext(
      { claudeAgentId: 'agent-b' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(divergentSameAgent)),
      }),
    );
    expect(fakeSockets).toHaveLength(2);
    const branchSocket = lastSocket();
    branchSocket.emit('open');
    emitTextResponse(branchSocket, 'resp_agent_b_branch', 'agent B branch done');
    await readAll(branch);
  });

  it('validates encrypted reasoning and exact assistant text before continuing', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'reason' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-reasoning' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: 'thinking',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 1,
      item: { type: 'message', id: 'msg_reason' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta', item_id: 'msg_reason', delta: 'answer',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: { type: 'message', id: 'msg_reason' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason' } })));
    await readAll(first);

    const reasoning = {
      type: 'reasoning', encrypted_content: 'enc_1',
      summary: [{ type: 'summary_text', text: 'thinking' }],
    };
    const assistant = { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] };
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, reasoning, assistant, nextUser])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(socket, 'resp_reason_next', 'done');
    await readAll(second);
  });

  it('continues when Claude omits reasoning but exactly echoes the following function call', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-omitted-reasoning',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{"path":"file.ts"}', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed', response: { id: 'resp_reason_tool' },
    })));
    await readAll(first);

    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason_tool');
    expect(sent.input).toEqual([toolOutput]);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'continuation',
      continuationMatchMode: 'omitted_reasoning',
      promotedConnectionId: 1,
      selectedGeneration: 'established',
    });
    emitTextResponse(socket, 'resp_after_tool', 'done');
    await readAll(second);
  });

  it('continues when Claude omits reasoning but exactly echoes the following assistant text', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'answer it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-omitted-reasoning-text' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_text' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'message', id: 'msg_1',
        content: [{ type: 'output_text', text: 'the answer' }], status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason_text' } })));
    await readAll(first);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] };
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'the answer' }] },
        nextUser,
      ])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason_text');
    expect(sent.input).toEqual([nextUser]);
  });

  it('does not ignore a mismatch in the assistant item after omitted reasoning', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-reasoning-mismatch' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}', status: 'completed' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason_tool' } })));
    await readAll(first);

    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { type: 'function_call', call_id: 'call_1', name: 'Write', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
      ])),
    });
    expect(fakeSockets).toHaveLength(2);
  });

  it('retains an unrelated parallel request and preserves both branch heads', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-parallel' });
    const main = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');

    const auxiliary = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'make a title' }] },
      ])),
    });
    const auxiliarySocket = lastSocket();
    expect(auxiliarySocket).not.toBe(mainSocket);
    auxiliarySocket.emit('open');
    emitTextResponse(auxiliarySocket, 'resp_aux', 'title');
    await readAll(auxiliary);

    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
        nextUser,
      ])),
    });
    expect(lastSocket()).toBe(auxiliarySocket); // no new socket was constructed
    const sent = JSON.parse(mainSocket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_main');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(mainSocket, 'resp_next', 'next answer');
    await readAll(next);

    const nextAuxiliaryUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'revise title' }],
    };
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'make a title' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'title' }] },
        nextAuxiliaryUser,
      ])),
    });
    expect(fakeSockets).toHaveLength(2);
    const auxiliarySent = JSON.parse(auxiliarySocket.send.mock.calls[1]![0] as string);
    expect(auxiliarySent.previous_response_id).toBe('resp_aux');
    expect(auxiliarySent.input).toEqual([nextAuxiliaryUser]);
  });

  it('retains parallel workflow-agent heads for independent continuation', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-parallel-workflow',
    });
    const roots = ['agent one', 'agent two', 'agent three'].map(text => [
      { role: 'user', content: [{ type: 'input_text', text }] },
    ]);
    const pending: Response[] = [];
    for (const input of roots) {
      pending.push(await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      }));
    }
    expect(fakeSockets).toHaveLength(3);

    fakeSockets.forEach((socket, index) => {
      socket.emit('open');
      emitTextResponse(socket, `resp_agent_${index}`, `answer ${index}`);
    });
    await Promise.all(pending.map(readAll));

    for (let index = 0; index < roots.length; index += 1) {
      const nextUser = {
        role: 'user',
        content: [{ type: 'input_text', text: `continue ${index}` }],
      };
      await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          ...roots[index]!,
          { role: 'assistant', content: [{ type: 'output_text', text: `answer ${index}` }] },
          nextUser,
        ])),
      });
      const sent = JSON.parse(fakeSockets[index]!.send.mock.calls[1]![0] as string);
      expect(sent.previous_response_id).toBe(`resp_agent_${index}`);
      expect(sent.input).toEqual([nextUser]);
      emitTextResponse(fakeSockets[index]!, `resp_agent_${index}_next`, `done ${index}`);
    }
    expect(fakeSockets).toHaveLength(3);
  });

  it('continues a workflow tool loop when Claude replays a reshaped reasoning envelope', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const root = [
      { role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] },
      { role: 'developer', content: [{ type: 'input_text', text: 'workflow agent' }] },
    ];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-workflow-replayed-reasoning',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(root)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created',
      response: { id: 'resp_workflow_reasoning' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_original',
        encrypted_content: 'opaque-original',
        summary: [{ type: 'summary_text', text: 'Use Bash.' }],
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_original',
        call_id: 'call_pwd',
        name: 'Bash',
        arguments: '{"command":"pwd"}',
        status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_workflow_reasoning' },
    })));
    await readAll(first);

    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call_pwd',
      output: '/tmp/workflow',
    };
    const next = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        ...root,
        {
          type: 'reasoning',
          encrypted_content: 'opaque-round-tripped',
          summary: [],
        },
        {
          type: 'function_call',
          call_id: 'call_pwd',
          name: 'Bash',
          arguments: '{ "command": "pwd" }',
        },
        toolOutput,
      ])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_workflow_reasoning');
    expect(sent.input).toEqual([toolOutput]);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'continuation',
      continuationMatchMode: 'replayed_reasoning',
      selectedConnectionId: 1,
    });
    emitTextResponse(socket, 'resp_workflow_done', 'done');
    await readAll(next);
  });

  it('retains the full 16-agent Claude workflow concurrency ceiling', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-full-width-workflow',
      onDiagnostic: event => diagnostics.push(event),
    });
    const pending: Response[] = [];
    for (let index = 0; index < 16; index += 1) {
      pending.push(await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text: `agent ${index}` }] },
        ])),
      }));
    }

    expect(fakeSockets).toHaveLength(16);
    expect(diagnostics.filter(
      event => event.event === 'ws_head_decision' && event.decision === 'parallel_isolated',
    )).toHaveLength(0);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'parallel_new_head',
      nurseryConnectionCount: 15,
      maxNurseryConnections: 16,
      createdGeneration: 'nursery',
    });

    fakeSockets.forEach((socket, index) => {
      socket.emit('open');
      emitTextResponse(socket, `resp_full_width_${index}`, `answer ${index}`);
    });
    await Promise.all(pending.map(readAll));

    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'continue agent 15' }],
    };
    await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'agent 15' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer 15' }] },
        nextUser,
      ])),
    });
    const sent = JSON.parse(fakeSockets[15]!.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_full_width_15');
    expect(sent.input).toEqual([nextUser]);
  });

  it('falls back to an isolated parallel socket when every nursery slot is active', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-parallel-cap',
      maxNurseryConnections: 2,
      onDiagnostic: event => diagnostics.push(event),
    });
    const pending: Response[] = [];
    for (const text of ['one', 'two', 'overflow']) {
      pending.push(await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text }] },
        ])),
      }));
    }
    expect(fakeSockets).toHaveLength(3);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'parallel_isolated',
      createdGeneration: 'isolated',
    });

    fakeSockets.forEach((socket, index) => {
      socket.emit('open');
      emitTextResponse(socket, `resp_cap_${index}`, `answer ${index}`);
    });
    await Promise.all(pending.map(readAll));

    const overflowContinuation = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'overflow' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer 2' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'continue overflow' }] },
      ])),
    });
    expect(fakeSockets).toHaveLength(3);
    const reusedNursery = fakeSockets.find(socket => socket.send.mock.calls.length === 2);
    expect(reusedNursery).toBeDefined();
    const sent = JSON.parse(reusedNursery!.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    emitTextResponse(reusedNursery!, 'resp_overflow_next', 'done');
    await readAll(overflowContinuation);
  });

  it('reuses a warm nursery socket for sequential divergent full-history requests', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-nursery-reuse',
      onDiagnostic: event => diagnostics.push(event),
    });
    const roots = ['branch one', 'branch two', 'branch three'].map(text => [
      { role: 'user', content: [{ type: 'input_text', text }] },
    ]);

    for (let index = 0; index < roots.length; index += 1) {
      const sendCounts = fakeSockets.map(socket => socket.send.mock.calls.length);
      const response = await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(roots[index]!)),
      });
      const socket = fakeSockets.find(
        (candidate, socketIndex) => candidate.send.mock.calls.length > (sendCounts[socketIndex] ?? 0),
      ) ?? lastSocket();
      if (index < 2) socket.emit('open');
      const sent = JSON.parse(socket.send.mock.calls.at(-1)![0] as string);
      expect(sent.previous_response_id).toBeUndefined();
      expect(sent.input).toEqual(roots[index]);
      emitTextResponse(socket, `resp_branch_${index}`, `answer ${index}`);
      await readAll(response);
    }

    expect(fakeSockets).toHaveLength(2);
    expect(fakeSockets[0]!.send).toHaveBeenCalledTimes(2);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_reused_head',
      selectedConnectionId: 1,
      selectedGeneration: 'nursery',
      createdConnectionId: undefined,
    });
  });

  it('reuses completed nursery heads across consecutive concurrent workflow waves', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-two-wave-workflow',
      onDiagnostic: event => diagnostics.push(event),
    });

    const runWave = async (labels: string[]): Promise<void> => {
      const pending: Response[] = [];
      const sendCounts = fakeSockets.map(socket => socket.send.mock.calls.length);
      for (const label of labels) {
        pending.push(await wsFetch('https://x', {
          method: 'POST',
          headers: {},
          body: JSON.stringify(sessionPayload([
            { role: 'user', content: [{ type: 'input_text', text: label }] },
          ])),
        }));
      }
      fakeSockets.forEach((socket, index) => {
        if (sendCounts[index] === undefined) socket.emit('open');
        if (socket.send.mock.calls.length <= (sendCounts[index] ?? 0)) return;
        emitTextResponse(socket, `resp_${labels.join('')}_${index}`, `answer ${index}`);
      });
      await Promise.all(pending.map(readAll));
    };

    await runWave(['A', 'B', 'C']);
    expect(fakeSockets).toHaveLength(3);
    await runWave(['D', 'E', 'F']);

    // Two warm heads are recycled. One anchor is preserved, so the third
    // concurrent branch creates exactly one new retained head.
    expect(fakeSockets).toHaveLength(4);
    expect(diagnostics.filter(
      event => event.event === 'ws_head_decision'
        && event.decision === 'history_mismatch_reused_head',
    )).toHaveLength(2);
    expect(diagnostics.filter(
      event => event.event === 'ws_head_decision'
        && event.decision === 'parallel_isolated',
    )).toHaveLength(0);
  });

  it('retains the main head when a completed auxiliary request starts another branch', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-hidden-branch' });
    const main = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');
    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);

    // Claude stop hooks/title generation can run after the visible response and
    // inherit the same session/model/effort partition with unrelated history.
    const auxiliaryInput = [{ role: 'user', content: [{ type: 'input_text', text: 'make a title' }] }];
    const auxiliary = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(auxiliaryInput)),
    });
    expect(fakeSockets).toHaveLength(2);
    const auxiliarySocket = lastSocket();
    auxiliarySocket.emit('open');
    emitTextResponse(auxiliarySocket, 'resp_aux', 'title');
    await readAll(auxiliary);
    expect(mainSocket.close).not.toHaveBeenCalled();

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
        nextUser,
      ])),
    });

    expect(fakeSockets).toHaveLength(2);
    const sent = JSON.parse(mainSocket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_main');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(mainSocket, 'resp_main_next', 'you are welcome');
    await readAll(next);
  });

  it('retries previous_response_not_found once on a new socket with full context', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-retry' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_old', 'answer');
    await readAll(first);

    const fullNextInput = [
      ...input,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullNextInput)),
    });
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));

    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const retried = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(retried.previous_response_id).toBeUndefined();
    expect(retried.input).toEqual(fullNextInput);
    emitTextResponse(replacement, 'resp_recovered', 'recovered');
    const body = await readAll(second);
    expect(body).not.toContain('previous_response_not_found');
  });

  it('still logs a retried rejection, which no error_frame record covers', async () => {
    // The retry frame carries a 400, so the rejection branch would claim it if
    // the willRetry arm of the diagnostic gate were dropped — and because the
    // retry returns before that branch, the failure would then be logged
    // NOWHERE. This pins the arm that prevents it.
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-retry-diag',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_old', 'answer');
    await readAll(first);

    const second = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
      ])),
    });
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_recovered', 'recovered');
    await readAll(second);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      source: 'response_event',
      errorCode: 'previous_response_not_found',
      willRetry: true,
    }));
  });

  it('resets a rewind/branch to full context and establishes the branch as the new head', async () => {
    const original = [{ role: 'user', content: [{ type: 'input_text', text: 'original' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-branch' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(original)),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_original', 'original answer');
    await readAll(first);

    const branchInput = [{ role: 'user', content: [{ type: 'input_text', text: 'different branch' }] }];
    const branch = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(branchInput)),
    });
    expect(fakeSockets).toHaveLength(2);
    const branchSocket = lastSocket();
    branchSocket.emit('open');
    const reset = JSON.parse(branchSocket.send.mock.calls[0]![0] as string);
    expect(reset.previous_response_id).toBeUndefined();
    expect(reset.input).toEqual(branchInput);
    emitTextResponse(branchSocket, 'resp_branch', 'branch answer');
    await readAll(branch);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'continue branch' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...branchInput,
        { role: 'assistant', content: [{ type: 'output_text', text: 'branch answer' }] },
        nextUser,
      ])),
    });
    const continued = JSON.parse(branchSocket.send.mock.calls[1]![0] as string);
    expect(continued.previous_response_id).toBe('resp_branch');
    expect(continued.input).toEqual([nextUser]);
    emitTextResponse(branchSocket, 'resp_branch_next', 'done');
    await readAll(next);
  });

  it('expires an idle chain and restarts with full context', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-ttl', idleTtlMs: 100, hardTtlMs: 1_000, now: () => now,
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_ttl', 'answer');
    await readAll(first);

    now += 101;
    const full = [...input, { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] }];
    await wsFetch('https://x', { method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(full)) });
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(full);
  });

  it('starts and resumes TTL clocks only after each response stream finishes', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-paused-ttl',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 100,
      hardTtlMs: 100,
      now: () => now,
    });
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
    });
    const socket = lastSocket();
    socket.emit('open');

    // The initial stream lasts far longer than every TTL, but none of that
    // in-flight time should age the retained head.
    now = 2_000;
    emitTextResponse(socket, 'resp_pause_1', 'answer one');
    await readAll(first);

    now = 2_050;
    const secondInput = [
      ...firstInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);

    // Suspend the already-running clocks during another long response.
    now = 3_050;
    emitTextResponse(socket, 'resp_pause_2', 'answer two');
    await readAll(second);

    now = 3_099;
    const thirdInput = [
      ...secondInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'three' }] },
    ];
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(thirdInput)),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBe('resp_pause_2');
  });

  it('promotes a continued nursery head and preserves it past the nursery TTL at capacity', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-generations',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 1_000,
      hardTtlMs: 10_000,
      maxConnections: 1,
      now: () => now,
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_gen_1', 'answer one');
    await readAll(first);

    now += 50;
    const secondInput = [
      ...input,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(socket, 'resp_gen_2', 'answer two');
    await readAll(second);

    now += 150;
    const thirdInput = [
      ...secondInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'three' }] },
    ];
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(thirdInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBe('resp_gen_2');
  });

  it('expires an unpromoted head on the shorter nursery TTL', async () => {
    let now = 1_000;
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-nursery-ttl',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 1_000,
      hardTtlMs: 10_000,
      now: () => now,
      onDiagnostic: event => diagnostics.push(event),
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_nursery', 'answer');
    await readAll(first);

    now += 101;
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
      ])),
    });

    expect(fakeSockets).toHaveLength(2);
    expect(socket.close).toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'new_partition_head',
      evictions: [{
        connectionId: 1,
        generation: 'nursery',
        reason: 'nursery_idle_ttl',
      }],
    });
  });

  it('keeps separate nursery capacity and evicts there without displacing a full established LRU', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-generation-lru',
      maxConnections: 1,
      maxNurseryConnections: 1,
      onDiagnostic: event => diagnostics.push(event),
    });
    const mainInput = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(mainInput)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');
    emitTextResponse(mainSocket, 'resp_main_1', 'main answer');
    await readAll(first);

    const mainNext = [
      ...mainInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'continue main' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(mainNext)),
    });
    emitTextResponse(mainSocket, 'resp_main_2', 'continued');
    await readAll(second);

    const branch = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'branch one' }] },
      ])),
    });
    const nurserySocket = lastSocket();
    nurserySocket.emit('open');
    emitTextResponse(nurserySocket, 'resp_branch_1', 'branch answer');
    await readAll(branch);
    expect(fakeSockets).toHaveLength(2);
    expect(mainSocket.close).not.toHaveBeenCalled();
    expect(nurserySocket.close).not.toHaveBeenCalled();

    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'branch two' }] },
      ])),
    });

    expect(fakeSockets).toHaveLength(3);
    expect(nurserySocket.close).toHaveBeenCalled();
    expect(mainSocket.close).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_new_head',
      evictions: [{
        connectionId: 2,
        generation: 'nursery',
        reason: 'nursery_lru_cap',
      }],
    });
  });

  it('partitions by provider, account, model, effort, session, and credential fingerprint', () => {
    const payload = sessionPayload([]);
    const options = { providerId: 'openai', accountId: 'a' };
    const base = responsesWebSocketPartitionKey(WS_URL, payload, options, 'credential-a');
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      { providerId: 'other', accountId: 'a' },
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      { providerId: 'openai', accountId: 'b' },
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, model: 'gpt-other' },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, reasoning: { effort: 'low' } },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, prompt_cache_key: 'other-session' },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      options,
      'credential-b',
    ));
    expect(base).toBe(responsesWebSocketPartitionKey(WS_URL, {
      ...payload,
      instructions: 'changed',
      tools: [{ type: 'function', name: 'Write' }],
    }, options, 'credential-a'));
  });

  it('canonicalizes object key ordering in prompt fingerprints', () => {
    expect(responsesWebSocketPromptFingerprint({ model: 'm', tools: [{ name: 'x', parameters: { b: 2, a: 1 } }], input: ['a'] }))
      .toBe(responsesWebSocketPromptFingerprint({ tools: [{ parameters: { a: 1, b: 2 }, name: 'x' }], model: 'm', input: ['different'] }));
  });

  it('rebases a known-oversized tool turn without dispatching the full history', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const canonical = [{ type: 'compaction', encrypted_content: 'overflow-prefix' }];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toEqual(root);
      return new Response(JSON.stringify({
        output: canonical,
        usage: {
          input_tokens: 90,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 2 },
          output_tokens: 10,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-overflow',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });
    const root = [{
      role: 'user',
      content: [{ type: 'input_text', text: 'p'.repeat(350_000) }],
    }];
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 80_000, claudeAgentId: 'workflow-overflow-a' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(root, { model: 'gpt-5.4' })),
      }),
    );
    const original = lastSocket();
    original.emit('open');
    emitToolCallResponse(original, 'resp_overflow_call', 'call_build', {
      input_tokens: 90_000,
      output_tokens: 5,
    });
    await readAll(first);

    const echoedCall = {
      type: 'function_call',
      call_id: 'call_build',
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call_build',
      output: 'x'.repeat(200_000),
    };
    const second = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 140_713, claudeAgentId: 'workflow-overflow-a' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput],
          { model: 'gpt-5.4' },
        )),
      }),
    );

    expect(compactFetch).toHaveBeenCalledOnce();
    expect(original.send).toHaveBeenCalledTimes(1);
    const replacement = lastSocket();
    expect(replacement).not.toBe(original);
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input[0]).toEqual(canonical[0]);
    expect(sent.input.at(-1)).toEqual(toolOutput);
    expect(sent.input).not.toEqual([...root, echoedCall, toolOutput]);
    emitTextResponse(replacement, 'resp_overflow_recovered', 'done', {
      input_tokens: 108_000,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 3 },
      output_tokens: 5,
    });
    const events = (await readAll(second))
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.replace(/^data: /, '')));
    expect(events.find(event => event.type === 'response.completed')?.response.usage)
      .toMatchObject({
        input_tokens: 108_090,
        output_tokens: 15,
        input_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 },
      });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_overflow_recovery',
      outcome: 'stage_accepted',
      reason: 'known_oversized',
    }));

    const echoedRecoveredAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    };
    const nextUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'continue after recovery' }],
    };
    const third = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 155_000, claudeAgentId: 'workflow-overflow-a' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput, echoedRecoveredAssistant, nextUser],
          { model: 'gpt-5.4' },
        )),
      }),
    );
    expect(compactFetch).toHaveBeenCalledOnce();
    expect(replacement.send).toHaveBeenCalledTimes(2);
    const continued = JSON.parse(replacement.send.mock.calls[1]![0] as string);
    expect(continued.previous_response_id).toBe('resp_overflow_recovered');
    expect(continued.input).toEqual([nextUser]);
    emitTextResponse(replacement, 'resp_overflow_continued', 'continued', {
      input_tokens: 108_100,
      output_tokens: 5,
    });
    await readAll(third);
    expect(compactFetch).toHaveBeenCalledOnce();
  });

  it('does not mutate transport state or dispatch when every compacted candidate exceeds the hard window', async () => {
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'compaction', encrypted_content: 'still-too-large' }],
      usage: { input_tokens: 100_000, output_tokens: 200_000 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-overflow-rejected-candidate',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
    });
    const input = [
      {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 's'.repeat(360_000) }],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'middle' }] },
      {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'l'.repeat(120_000) }],
      },
    ];

    const response = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 140_000, claudeAgentId: 'workflow-no-dispatch' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(input, { model: 'gpt-5.4' })),
      }),
    );

    expect(response.status).toBe(400);
    expect(fakeSockets).toHaveLength(0);
    expect(compactFetch).toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: { code: 'context_length_exceeded' },
    });
  });

  it('commits only a later accepted candidate and replaces the original logical head', async () => {
    const compactBodies: unknown[][] = [];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: unknown[] };
      compactBodies.push(body.input);
      const first = compactBodies.length === 1;
      return new Response(JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: first ? 'rejected' : 'accepted' }],
        usage: { input_tokens: 80_000, output_tokens: first ? 200_000 : 1_000 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-overflow-later-candidate',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
    });
    const root = [
      {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 's'.repeat(320_000) }],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] },
      {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'i'.repeat(80_000) }],
      },
    ];
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload(root, { model: 'gpt-5.4' })),
    });
    const original = lastSocket();
    original.emit('open');
    emitToolCallResponse(original, 'resp_later_candidate_base', 'call_later');
    await readAll(first);
    const echoedCall = {
      type: 'function_call', call_id: 'call_later', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output', call_id: 'call_later', output: 'r'.repeat(160_000),
    };
    const recovered = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 140_000, claudeAgentId: 'workflow-later-candidate' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput],
          { model: 'gpt-5.4' },
        )),
      }),
    );

    expect(compactBodies.length).toBeGreaterThanOrEqual(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.input[0]).toMatchObject({ encrypted_content: 'accepted' });
    expect(sent.input[0]).not.toMatchObject({ encrypted_content: 'rejected' });
    emitTextResponse(replacement, 'resp_later_candidate_recovered', 'done');
    await readAll(recovered);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const continued = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([
        ...root,
        echoedCall,
        toolOutput,
        { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        nextUser,
      ], { model: 'gpt-5.4' })),
    });
    const continuationSocket = lastSocket();
    const continuationPayload = JSON.parse(
      continuationSocket.send.mock.calls.at(-1)![0] as string,
    );
    expect(continuationPayload.previous_response_id).toBe('resp_later_candidate_recovered');
    expect(continuationPayload.input).toEqual([nextUser]);
    emitTextResponse(continuationSocket, 'resp_later_candidate_continued', 'continued');
    await readAll(continued);
    expect(original.close).toHaveBeenCalledTimes(replacement === original ? 0 : 1);
  });

  it('does not resend an oversized window after the compact endpoint rejects it', async () => {
    const canonical = [{ type: 'compaction', encrypted_content: 'fallback-prefix' }];
    const compactBodies: unknown[][] = [];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      compactBodies.push(body.input);
      if (compactBodies.length === 1) {
        return new Response(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            message: 'maximum context length exceeded',
          },
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ output: canonical }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-compact-400-recovery',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
    });
    const root = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 's'.repeat(320_000) }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'i'.repeat(80_000) }] },
    ];
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(root)),
    });
    const original = lastSocket();
    original.emit('open');
    emitToolCallResponse(original, 'resp_compact_400_base', 'call_400', {
      input_tokens: 110_000,
      output_tokens: 5,
    });
    await readAll(first);

    const echoedCall = {
      type: 'function_call',
      call_id: 'call_400',
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call_400',
      output: 'large result',
    };
    const nextPromise = withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 100 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([...root, echoedCall, toolOutput])),
      }),
    );
    await waitForCondition(() => expect(original.send).toHaveBeenCalledTimes(2));
    original.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'trigger exceeds maximum context length',
      },
    })));
    const next = await nextPromise;

    await waitForCondition(() => expect(compactBodies).toHaveLength(2));
    expect(compactBodies[0]).toEqual([...root, echoedCall, toolOutput]);
    expect(compactBodies[1]).toEqual(root);
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.input[0]).toEqual(canonical[0]);
    expect(sent.input.at(-1)).toEqual(toolOutput);
    expect(sent.input).not.toEqual(compactBodies[0]);
    emitTextResponse(replacement, 'resp_compact_400_recovered', 'done');
    await readAll(next);
  });

  it('progressively folds a large workflow transcript after a one-shot compact rejection', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const fullInput = Array.from({ length: 793 }, (_, index) => [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `user-${index}-${'u'.repeat(500)}` }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `assistant-${index}-${'a'.repeat(500)}` }],
      },
    ]).flat();
    const compactBodies: unknown[][] = [];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: unknown[] };
      compactBodies.push(body.input);
      if (compactBodies.length === 1) {
        return new Response(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            message: 'maximum context length exceeded',
          },
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const stage = compactBodies.length - 1;
      return new Response(JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: `canonical-${stage}` }],
        usage: {
          input_tokens: 60_000,
          input_tokens_details: { cached_tokens: 55_000 },
          output_tokens: 1_000,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-progressive-overflow',
      compactThreshold: 70_000,
      contextWindow: 250_000,
      overflowRecoveryMaxCompactCalls: 8,
      compactFetch: compactFetch as typeof fetch,
      onDiagnostic: event => diagnostics.push(event),
    });

    const response = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 220_000, claudeAgentId: 'workflow-progressive-overflow' },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(fullInput, { model: 'gpt-5.6-sol' })),
      }),
    );

    expect(compactBodies.length).toBeGreaterThanOrEqual(4);
    expect(compactBodies[0]).toEqual(fullInput);
    const successfulBodies = compactBodies.slice(1);
    for (let index = 1; index < successfulBodies.length; index += 1) {
      expect(successfulBodies[index]![0]).toMatchObject({
        type: 'compaction',
        encrypted_content: `canonical-${index}`,
      });
    }

    const initialReplacement = lastSocket();
    initialReplacement.emit('open');
    const sent = JSON.parse(initialReplacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input.length).toBeLessThan(successfulBodies.at(-1)!.length);
    expect(sent.input[0]).toMatchObject({ type: 'compaction' });
    const compactsBeforeCreateRejection = compactBodies.length;
    initialReplacement.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'create still exceeds maximum context length',
      },
    })));
    await waitForCondition(() => {
      expect(compactBodies.length).toBe(compactsBeforeCreateRejection + 1);
      expect(fakeSockets.length).toBeGreaterThanOrEqual(2);
    });
    expect(compactBodies.length).toBeLessThanOrEqual(8);
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_progressive_overflow', 'recovered', {
      input_tokens: 60_000,
      input_tokens_details: { cached_tokens: 55_000 },
      output_tokens: 10,
    });
    const events = (await readAll(response))
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.replace(/^data: /, '')));
    const completedUsage = events.find(event => event.type === 'response.completed')?.response.usage;
    const compactStages = compactBodies.length - 1;
    expect(completedUsage).toMatchObject({
      input_tokens: 60_000 + compactStages * 60_000,
      output_tokens: 10 + compactStages * 1_000,
      input_tokens_details: { cached_tokens: 55_000 + compactStages * 55_000 },
    });
    const completedStages = diagnostics.filter(event => (
      event.event === 'ws_overflow_recovery'
      && event.outcome === 'stage_accepted'
      && typeof event.stage === 'number'
      && event.stage > 0
    ));
    expect(completedStages.length).toBe(compactStages - 1);
    expect(completedStages.map(event => event.stage)).toEqual(
      Array.from({ length: compactStages - 1 }, (_, index) => index + 1),
    );
    const rebasedItemCounts = completedStages.map(event => event.inputItems as number);
    for (let index = 1; index < rebasedItemCounts.length; index += 1) {
      expect(rebasedItemCounts[index]).toBeLessThan(rebasedItemCounts[index - 1]!);
    }
  });

  it('retires the original source head exactly once after a second recovery succeeds', async () => {
    let compactCall = 0;
    const compactFetch = vi.fn(async () => {
      compactCall += 1;
      return new Response(JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: `rebase-${compactCall}` }],
        usage: { input_tokens: 100_000, output_tokens: 1_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-second-recovery-success',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
    });
    const root = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 's'.repeat(320_000) }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'i'.repeat(80_000) }] },
    ];
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload(root, { model: 'gpt-5.4' })),
    });
    const original = lastSocket();
    original.emit('open');
    emitToolCallResponse(original, 'resp_second_recovery_base', 'call_second', {
      input_tokens: 100_000,
      output_tokens: 5,
    });
    await readAll(first);
    const echoedCall = {
      type: 'function_call', call_id: 'call_second', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output', call_id: 'call_second', output: 'x'.repeat(160_000),
    };
    const response = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 140_000 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput],
          { model: 'gpt-5.4' },
        )),
      }),
    );
    const firstReplacement = lastSocket();
    expect(firstReplacement).not.toBe(original);
    firstReplacement.emit('open');
    firstReplacement.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'first rebase still exceeds context',
      },
    })));
    await waitForCondition(() => expect(fakeSockets).toHaveLength(3));
    const finalReplacement = lastSocket();
    finalReplacement.emit('open');
    emitTextResponse(finalReplacement, 'resp_second_recovery_final', 'done');
    await readAll(response);

    expect(compactFetch).toHaveBeenCalledTimes(2);
    expect(firstReplacement.close).toHaveBeenCalledTimes(1);
    expect(original.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the original source head when a second recovery exhausts', async () => {
    let compactCall = 0;
    const compactFetch = vi.fn(async () => {
      compactCall += 1;
      if (compactCall === 1) {
        return new Response(JSON.stringify({
          output: [{ type: 'compaction', encrypted_content: 'initial-rebase' }],
          usage: { input_tokens: 100_000, output_tokens: 1_000 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          message: 'compact prefix still exceeds context',
        },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-second-recovery-exhausted',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
      overflowRecoveryMaxContextRejections: 1,
    });
    const root = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 's'.repeat(320_000) }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'i'.repeat(80_000) }] },
    ];
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload(root, { model: 'gpt-5.4' })),
    });
    const original = lastSocket();
    original.emit('open');
    emitToolCallResponse(original, 'resp_second_recovery_preserved', 'call_preserved', {
      input_tokens: 100_000,
      output_tokens: 5,
    });
    await readAll(first);
    const echoedCall = {
      type: 'function_call', call_id: 'call_preserved', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output', call_id: 'call_preserved', output: 'x'.repeat(160_000),
    };
    const response = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 140_000 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput],
          { model: 'gpt-5.4' },
        )),
      }),
    );
    const rejectedReplacement = lastSocket();
    rejectedReplacement.emit('open');
    rejectedReplacement.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'first rebase still exceeds context',
      },
    })));
    expect(await readAll(response)).toContain('"code":"400"');
    expect(compactFetch).toHaveBeenCalledTimes(2);
    expect(rejectedReplacement.close).toHaveBeenCalledTimes(1);
    expect(original.close).not.toHaveBeenCalled();

    const continued = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 100 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput],
          { model: 'gpt-5.4' },
        )),
      }),
    );
    expect(fakeSockets).toHaveLength(2);
    expect(original.send).toHaveBeenCalledTimes(2);
    const continuationPayload = JSON.parse(original.send.mock.calls.at(-1)![0] as string);
    expect(continuationPayload.previous_response_id).toBe('resp_second_recovery_preserved');
    emitTextResponse(original, 'resp_preserved_continuation', 'continued');
    await readAll(continued);
  });

  it('does not dispatch a model create after recovery consumes its final-create reserve', async () => {
    let now = 1_000;
    const compactFetch = vi.fn(async () => {
      now += 901;
      return new Response(JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'too-late' }],
        usage: { input_tokens: 100_000, output_tokens: 1_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-final-create-reserve',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
      overflowRecoveryDeadlineMs: 1_000,
      overflowRecoveryFinalCreateReserveMs: 100,
      now: () => now,
    });
    const root = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 's'.repeat(320_000) }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'i'.repeat(80_000) }] },
    ];
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload(root, { model: 'gpt-5.4' })),
    });
    const original = lastSocket();
    original.emit('open');
    emitToolCallResponse(original, 'resp_final_reserve_base', 'call_final_reserve', {
      input_tokens: 100_000,
      output_tokens: 5,
    });
    await readAll(first);
    const echoedCall = {
      type: 'function_call', call_id: 'call_final_reserve', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output', call_id: 'call_final_reserve', output: 'x'.repeat(160_000),
    };
    const response = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 140_000 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput],
          { model: 'gpt-5.4' },
        )),
      }),
    );

    expect(response.status).toBe(400);
    expect(fakeSockets).toHaveLength(1);
    expect(compactFetch).toHaveBeenCalledTimes(1);
    expect(original.close).not.toHaveBeenCalled();
  });

  it('preserves a non-context compact failure instead of relabeling it as overflow', async () => {
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { type: 'authentication_error', code: 'invalid_api_key', message: 'expired' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-overflow-auth-failure',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
    });
    const response = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 100 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
        ])),
      }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'request exceeds context',
      },
    })));

    const body = await readAll(response);
    expect(compactFetch).toHaveBeenCalledTimes(1);
    expect(body).toContain('"code":"401"');
    expect(body).not.toContain('no dependency-safe native recovery');
    expect(fakeSockets).toHaveLength(1);
  });

  it('recovers one upstream context rejection before output and never replays after output', async () => {
    const canonical = [{ type: 'compaction', encrypted_content: 'response-recovery' }];
    const compactFetch = vi.fn(async () => new Response(JSON.stringify({
      output: canonical,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-response-overflow',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
    });
    const root = [{ role: 'user', content: [{ type: 'input_text', text: 'first' }] }];
    const first = await wsFetch('https://example.test/responses', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload(root)),
    });
    const original = lastSocket();
    original.emit('open');
    emitToolCallResponse(original, 'resp_response_overflow_base', 'call_response', {
      input_tokens: 90_000,
      output_tokens: 5,
    });
    await readAll(first);

    const echoedCall = {
      type: 'function_call',
      call_id: 'call_response',
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call_response',
      output: 'result',
    };
    const next = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 100 },
      () => wsFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([...root, echoedCall, toolOutput])),
      }),
    );
    original.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'maximum context length exceeded',
      },
    })));
    await waitForCondition(() => expect(fakeSockets.length).toBe(2));
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_response_overflow_recovered', 'done');
    await readAll(next);
    expect(compactFetch).toHaveBeenCalledOnce();

    const noReplayFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-response-overflow-no-replay',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch: compactFetch as typeof fetch,
    });
    const terminal = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 10_000 },
      () => noReplayFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(root)),
      }),
    );
    const partialSocket = lastSocket();
    partialSocket.emit('open');
    partialSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      item_id: 'msg_partial',
      delta: 'partial',
    })));
    partialSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'maximum context length exceeded',
      },
    })));
    await readAll(terminal);
    expect(compactFetch).toHaveBeenCalledOnce();
  });

  it('admits an oversized raw resume from its smaller durable checkpoint after restart', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(
      process.env.CLODEX_HOME!,
      'oversized-raw-resume-checkpoints-',
    ));
    const canonical = [{ type: 'compaction', encrypted_content: 'durable-resume' }];
    const compactBodies: unknown[][] = [];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      compactBodies.push(body.input);
      return new Response(JSON.stringify({ output: canonical }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const options = {
      accountId: 'acct-oversized-raw-resume',
      compactThreshold: 265_000,
      contextWindow: 1_000_000,
      checkpointStoreDir,
      compactFetch: compactFetch as typeof fetch,
    };
    const root = [{
      role: 'user',
      content: [{ type: 'input_text', text: 'r'.repeat(400_000) }],
    }];
    const beforeRestartFetch = createResponsesWebSocketFetch(WS_URL, undefined, options);
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 270_000, claudeAgentId: 'oversized-raw-resume' },
      () => beforeRestartFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(root, { model: 'gpt-5.6-luna' })),
      }),
    );
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    const assistant = {
      type: 'function_call',
      id: 'fc_durable_resume',
      call_id: 'call_durable_resume',
      name: 'Bash',
      arguments: '{"command":"pwd"}',
      status: 'completed',
    };
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created', response: { id: 'resp_durable_resume' },
    })));
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0, item: assistant,
    })));
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_durable_resume',
        usage: { input_tokens: 220_000, output_tokens: 5 },
      },
    })));
    await readAll(first);
    expect(compactBodies).toEqual([root]);
    expect(readdirSync(checkpointStoreDir)).toHaveLength(1);

    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const afterRestartFetch = createResponsesWebSocketFetch(WS_URL, undefined, options);
    const echoedCall = {
      type: 'function_call',
      call_id: 'call_durable_resume',
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    };
    const toolOutput = {
      type: 'function_call_output',
      call_id: 'call_durable_resume',
      output: 'continued after restart',
    };
    const resumed = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 1_100_000, claudeAgentId: 'oversized-raw-resume' },
      () => afterRestartFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedCall, toolOutput],
          { model: 'gpt-5.6-luna' },
        )),
      }),
    );

    expect(compactBodies).toHaveLength(1);
    const resumedSocket = lastSocket();
    resumedSocket.emit('open');
    const sent = JSON.parse(resumedSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual([canonical[0], echoedCall, toolOutput]);
    emitTextResponse(resumedSocket, 'resp_durable_resume_done', 'done');
    await readAll(resumed);
    rmSync(checkpointStoreDir, { recursive: true, force: true });
  });

  it('recovers an oversized Workflow tool tail from its durable checkpoint after restart', async () => {
    mkdirSync(process.env.CLODEX_HOME!, { recursive: true });
    const checkpointStoreDir = mkdtempSync(join(
      process.env.CLODEX_HOME!,
      'overflow-restart-checkpoints-',
    ));
    const firstCanonical = [{ type: 'compaction', encrypted_content: 'before-restart' }];
    const secondCanonical = [{ type: 'compaction', encrypted_content: 'after-restart' }];
    const compactBodies: unknown[][] = [];
    const compactFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      compactBodies.push(body.input);
      return new Response(JSON.stringify({
        output: compactBodies.length === 1 ? firstCanonical : secondCanonical,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const options = {
      accountId: 'acct-overflow-restart',
      compactThreshold: 115_200,
      contextWindow: 128_000,
      checkpointStoreDir,
      compactFetch: compactFetch as typeof fetch,
    };
    const root = [{
      role: 'user',
      content: [{ type: 'input_text', text: 'p'.repeat(400_000) }],
    }];
    const beforeRestartFetch = createResponsesWebSocketFetch(WS_URL, undefined, options);
    const first = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 120_000, claudeAgentId: 'workflow-restart' },
      () => beforeRestartFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(root, { model: 'gpt-5.4' })),
      }),
    );
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.created', response: { id: 'resp_overflow_before_restart' },
    })));
    const firstAssistantItems = [
      { type: 'reasoning', id: 'rs_restart', encrypted_content: 'opaque-restart', summary: [] },
      {
        type: 'function_call', id: 'fc_restart', call_id: 'call_restart',
        name: 'Bash', arguments: '{"command":"pwd"}', status: 'completed',
      },
      {
        type: 'custom_tool_call', id: 'ct_restart', call_id: 'custom_restart',
        name: 'computer', input: '{"action":"screenshot"}', status: 'completed',
      },
    ];
    firstAssistantItems.forEach((item, outputIndex) => firstSocket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'response.output_item.done', output_index: outputIndex, item })),
    ));
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_overflow_before_restart',
        usage: { input_tokens: 90_000, output_tokens: 5 },
      },
    })));
    await readAll(first);
    expect(readdirSync(checkpointStoreDir)).toHaveLength(1);

    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
    const afterRestartFetch = createResponsesWebSocketFetch(WS_URL, undefined, options);
    const echoedReasoning = { type: 'reasoning', encrypted_content: 'opaque-restart', summary: [] };
    const echoedCall = {
      type: 'function_call', call_id: 'call_restart', name: 'Bash', arguments: '{"command":"pwd"}',
    };
    const echoedCustomCall = {
      type: 'custom_tool_call', call_id: 'custom_restart', name: 'computer',
      input: '{"action":"screenshot"}',
    };
    const toolOutput = {
      type: 'function_call_output', call_id: 'call_restart', output: 'x'.repeat(100_000),
    };
    const customOutput = {
      type: 'custom_tool_call_output', call_id: 'custom_restart', output: 'y'.repeat(100_000),
    };
    const afterRestart = await withResponsesWebSocketDiagnosticContext(
      { estimatedInputTokens: 150_000, claudeAgentId: 'workflow-restart' },
      () => afterRestartFetch('https://example.test/responses', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload(
          [...root, echoedReasoning, echoedCall, echoedCustomCall, toolOutput, customOutput],
          { model: 'gpt-5.4' },
        )),
      }),
    );

    expect(compactBodies).toHaveLength(2);
    expect(compactBodies[0]).toEqual(root);
    expect(compactBodies[1]).toEqual(firstCanonical);
    const recoveredSocket = lastSocket();
    recoveredSocket.emit('open');
    const sent = JSON.parse(recoveredSocket.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual([
      secondCanonical[0],
      echoedReasoning,
      echoedCall,
      echoedCustomCall,
      toolOutput,
      customOutput,
    ]);
    emitTextResponse(recoveredSocket, 'resp_overflow_after_restart', 'done');
    await readAll(afterRestart);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'continue' }] };
    const continued = await afterRestartFetch('https://example.test/responses', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([
        ...root,
        echoedReasoning,
        echoedCall,
        echoedCustomCall,
        toolOutput,
        customOutput,
        { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        nextUser,
      ], { model: 'gpt-5.4' })),
    });
    const continuationPayload = JSON.parse(recoveredSocket.send.mock.calls.at(-1)![0] as string);
    expect(continuationPayload.previous_response_id).toBe('resp_overflow_after_restart');
    expect(continuationPayload.input).toEqual([nextUser]);
    emitTextResponse(recoveredSocket, 'resp_overflow_continued', 'continued');
    await readAll(continued);
    rmSync(checkpointStoreDir, { recursive: true, force: true });
  });
});
