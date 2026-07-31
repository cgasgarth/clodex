import { tool, jsonSchema, streamText, generateText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { parseToolArguments } from './proxy-shared.js';
import type { SdkCallParams } from './sdk-adapter.js';

// ── OpenAI request shapes ───────────────────────────────────────────────────

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | Array<Record<string, unknown>>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAiRequest {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

// ── Translation: OpenAI Request → SDK Call Params ───────────────────────────

export function translateOpenAiRequest(
  body: OpenAiRequest,
  options?: {
    /** ChatGPT Codex OAuth requires instructions in providerOptions and manages its own output limit. */
    openAiOAuth?: boolean;
  },
): SdkCallParams {
  // Pre-scan to map tool_call_id → function name so tool result messages can reference it.
  const toolNameById = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }

  let system: string | undefined;
  const messages: ModelMessage[] = [];

  for (const msg of body.messages) {
    switch (msg.role) {
      case 'system':
        system = typeof msg.content === 'string' ? msg.content : undefined;
        break;

      case 'user':
        messages.push({ role: 'user', content: msg.content ?? '' } as unknown as ModelMessage);
        break;

      case 'assistant': {
        const parts: Array<Record<string, unknown>> = [];
        if (typeof msg.content === 'string' && msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls ?? []) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: parseToolArguments(tc.function.arguments),
          });
        }
        messages.push({ role: 'assistant', content: parts.length > 0 ? parts : '' } as unknown as ModelMessage);
        break;
      }

      case 'tool': {
        const resultPart = {
          type: 'tool-result' as const,
          toolCallId: msg.tool_call_id ?? '',
          toolName: toolNameById.get(msg.tool_call_id ?? '') ?? 'unknown',
          output: {
            type: 'text' as const,
            value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
          },
        };
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'tool' && Array.isArray(lastMsg.content)) {
          lastMsg.content.push(resultPart);
        } else {
          messages.push({ role: 'tool', content: [resultPart] } as unknown as ModelMessage);
        }
        break;
      }
    }
  }

  let sdkToolChoice: SdkCallParams['toolChoice'];
  if (body.tool_choice === 'auto' || body.tool_choice === 'required') {
    sdkToolChoice = body.tool_choice;
  } else if (typeof body.tool_choice === 'object') {
    sdkToolChoice = { type: 'tool', toolName: body.tool_choice.function.name };
  }

  let tools: SdkCallParams['tools'];
  if (body.tools?.length) {
    tools = {};
    for (const t of body.tools) {
      const schema = t.function.parameters ? jsonSchema(t.function.parameters) : undefined;
      tools[t.function.name] = tool({
        description: t.function.description ?? '',
        inputSchema: schema ?? jsonSchema({ type: 'object', properties: {} }),
      });
    }
  }

  if (options?.openAiOAuth) {
    // Mirror the OAuth shaping in sdk-adapter's translateRequest: the ChatGPT
    // Codex OAuth backend rejects the standard system/instructions field (it
    // requires providerOptions.openai.instructions), manages its own output
    // limit (an explicit max_output_tokens yields an empty finish:'other'
    // response), and expects store:false.
    const instructions = system?.trim() || 'You are a coding assistant.';
    return {
      messages,
      tools,
      toolChoice: sdkToolChoice,
      temperature: body.temperature,
      providerOptions: {
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          instructions,
        },
      },
    };
  }

  return {
    instructions: system,
    messages,
    tools,
    toolChoice: sdkToolChoice,
    temperature: body.temperature,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
  };
}

// ── Translation: SDK Response → OpenAI JSON / SSE ───────────────────────────

export interface CollectedOpenAiStream {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: string | undefined;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
}

/** Reduce an SDK full stream into the fields a non-streaming chat completion needs. */
export async function collectOpenAiStream(stream: AsyncIterable<unknown>): Promise<CollectedOpenAiStream> {
  const collected: CollectedOpenAiStream = { text: '', toolCalls: [], finishReason: undefined, usage: undefined };
  for await (const part of stream) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    switch (p.type) {
      case 'text-delta':
        collected.text += typeof p.textDelta === 'string'
          ? p.textDelta
          : typeof p.text === 'string' ? p.text : '';
        break;
      case 'tool-call':
        collected.toolCalls.push({
          toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : '',
          toolName: typeof p.toolName === 'string' ? p.toolName : '',
          input: p.input,
        });
        break;
      case 'finish':
        if (typeof p.finishReason === 'string') collected.finishReason = p.finishReason;
        const usage = p.totalUsage ?? p.usage;
        if (usage && typeof usage === 'object') {
          collected.usage = usage;
        }
        break;
      case 'error':
        throw p.error instanceof Error || (p.error !== null && typeof p.error === 'object')
          ? p.error
          : new Error(typeof p.error === 'string' ? p.error : 'Upstream stream failed');
    }
  }
  return collected;
}

export async function generateOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  options?: { forceStream?: boolean },
) {
  let result: { text: string; toolCalls?: CollectedOpenAiStream['toolCalls']; finishReason?: string; usage?: CollectedOpenAiStream['usage'] };
  if (options?.forceStream) {
    // Some upstreams (e.g. ChatGPT's Codex OAuth backend) only ever answer as a
    // stream. Request a real stream from the SDK and collect it into one
    // response instead of issuing a non-streaming request upstream.
    const { stream } = streamText(toStreamTextOptions(model, params, { onError: () => {} }));
    result = await collectOpenAiStream(stream);
  } else {
    result = await generateText(toGenerateTextOptions(model, params));
  }
  const message: Record<string, unknown> = { role: 'assistant', content: result.text || null };

  if (result.toolCalls?.length) {
    message.tool_calls = result.toolCalls.map(tc => ({
      id: tc.toolCallId,
      type: 'function',
      function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
    }));
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: responseModelId,
    choices: [{ index: 0, message, finish_reason: result.finishReason || 'stop' }],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
      total_tokens: result.usage?.totalTokens ?? 0,
    },
  };
}

export async function streamOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const { stream } = streamText(toStreamTextOptions(model, params));
  const baseData = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: responseModelId,
  };

  const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    onChunk(`data: ${JSON.stringify({ ...baseData, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);

  for await (const part of stream) {
    const p = part as unknown as Record<string, unknown>;
    switch (p.type) {
      case 'text-delta':
        send({ role: 'assistant', content: p.textDelta ?? p.text ?? '' });
        break;
      case 'tool-input-start':
        send({ role: 'assistant', tool_calls: [{ index: 0, id: p.id ?? p.toolCallId, type: 'function', function: { name: p.toolName, arguments: '' } }] });
        break;
      case 'tool-input-delta':
        send({ tool_calls: [{ index: 0, function: { arguments: p.delta ?? p.text ?? p.argsTextDelta ?? '' } }] });
        break;
      case 'finish':
        send({}, typeof p.finishReason === 'string' ? p.finishReason : 'stop');
        break;
      case 'error':
        throw p.error instanceof Error || (p.error !== null && typeof p.error === 'object')
          ? p.error
          : new Error(typeof p.error === 'string' ? p.error : 'Upstream stream failed');
    }
  }

  onChunk('data: [DONE]\n\n');
}

function toStreamTextOptions(
  model: LanguageModel,
  params: SdkCallParams,
  extra: Record<string, unknown> = {},
): Parameters<typeof streamText>[0] {
  return { model, ...params, ...extra } as unknown as Parameters<typeof streamText>[0];
}

function toGenerateTextOptions(
  model: LanguageModel,
  params: SdkCallParams,
): Parameters<typeof generateText>[0] {
  return { model, ...params } as unknown as Parameters<typeof generateText>[0];
}
