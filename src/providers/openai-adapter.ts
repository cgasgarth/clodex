import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import { tool, jsonSchema, streamText, generateText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { parseToolArguments } from '../proxy/shared.js';
import type { SdkCallParams } from '../sdk-adapter.js';
import { diagnosticRecord } from '../observability/trace-log.js';
import type { DiagnosticRecord } from '../observability/trace-log.js';

// ── OpenAI request shapes ───────────────────────────────────────────────────

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | DiagnosticRecord[];
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
    function: { name: string; description?: string; parameters?: DiagnosticRecord };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

interface SdkMessagePayload {
  content: unknown;
}

function sdkModelMessage(
  role: 'user' | 'assistant',
  content: SdkMessagePayload['content'],
): ModelMessage {
  const message: ModelMessage = { role: 'user', content: '' };
  Object.assign(message, { role, content });
  return message;
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
        system = isString(msg.content) ? msg.content : undefined;
        break;

      case 'user':
        messages.push(sdkModelMessage('user', msg.content ?? ''));
        break;

      case 'assistant': {
        const parts: DiagnosticRecord[] = [];
        if (isString(msg.content) && msg.content) {
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
        messages.push(sdkModelMessage('assistant', parts.length > 0 ? parts : ''));
        break;
      }

      case 'tool': {
        const resultPart = {
          type: 'tool-result' as const,
          toolCallId: msg.tool_call_id ?? '',
          toolName: toolNameById.get(msg.tool_call_id ?? '') ?? 'unknown',
          output: {
            type: 'text' as const,
            value: isString(msg.content) ? msg.content : JSON.stringify(msg.content ?? ''),
          },
        };
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'tool' && Array.isArray(lastMsg.content)) {
          lastMsg.content.push(resultPart);
        } else {
          messages.push({ role: 'tool', content: [resultPart] });
        }
        break;
      }
    }
  }

  let sdkToolChoice: SdkCallParams['toolChoice'];
  if (body.tool_choice === 'auto' || body.tool_choice === 'required') {
    sdkToolChoice = body.tool_choice;
  } else if (isObject(body.tool_choice)) {
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

type StreamTextExtra = Pick<Parameters<typeof streamText>[0], 'onError'>;

/** Reduce an SDK full stream into the fields a non-streaming chat completion needs. */
export async function collectOpenAiStream(stream: AsyncIterable<unknown>): Promise<CollectedOpenAiStream> {
  const collected: CollectedOpenAiStream = { text: '', toolCalls: [], finishReason: undefined, usage: undefined };
  for await (const part of stream) {
    if (!part || !isObject(part)) continue;
    const p = diagnosticRecord(part);
    switch (p.type) {
      case 'text-delta':
        collected.text += isString(p.textDelta)
          ? p.textDelta
          : isString(p.text) ? p.text : '';
        break;
      case 'tool-call':
        collected.toolCalls.push({
          toolCallId: isString(p.toolCallId) ? p.toolCallId : '',
          toolName: isString(p.toolName) ? p.toolName : '',
          input: p.input,
        });
        break;
      case 'finish': {
        if (isString(p.finishReason)) collected.finishReason = p.finishReason;
        const usage = p.totalUsage ?? p.usage;
        if (usage && isObject(usage)) {
          const usageRecord = diagnosticRecord(usage);
          collected.usage = {
            inputTokens: isNumber(usageRecord.inputTokens) ? usageRecord.inputTokens : undefined,
            outputTokens: isNumber(usageRecord.outputTokens) ? usageRecord.outputTokens : undefined,
            totalTokens: isNumber(usageRecord.totalTokens) ? usageRecord.totalTokens : undefined,
          };
        }
        break;
      }
      case 'error':
        throw p.error instanceof Error || (p.error !== null && isObject(p.error))
          ? p.error
          : new Error(isString(p.error) ? p.error : 'Upstream stream failed');
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
  const message: DiagnosticRecord = { role: 'assistant', content: result.text || null };

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

  const send = (delta: DiagnosticRecord, finish_reason: string | null = null) =>
    onChunk(`data: ${JSON.stringify({ ...baseData, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);

  for await (const part of stream) {
    const p = diagnosticRecord(part);
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
        send({}, isString(p.finishReason) ? p.finishReason : 'stop');
        break;
      case 'error':
        throw p.error instanceof Error || (p.error !== null && isObject(p.error))
          ? p.error
          : new Error(isString(p.error) ? p.error : 'Upstream stream failed');
    }
  }

  onChunk('data: [DONE]\n\n');
}

function toStreamTextOptions(
  model: LanguageModel,
  params: SdkCallParams,
  extra: StreamTextExtra = {},
): Parameters<typeof streamText>[0] {
  return { model, ...params, ...extra };
}

function toGenerateTextOptions(
  model: LanguageModel,
  params: SdkCallParams,
): Parameters<typeof generateText>[0] {
  return { model, ...params };
}
