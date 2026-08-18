import { createHash, randomUUID } from 'node:crypto';
import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import { streamText } from 'ai';
import {
  CODEX_RESPONSES_LITE_VERSION,
  CODEX_RESPONSES_LITE_WS_URL,
} from '../src/constants.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
import { compactResponsesWindow } from '../src/oauth/responses-compaction.js';
import { createResponsesWebSocketFetch } from '../src/oauth/responses-websocket.js';
import type { ResponsesWebSocketDiagnosticEvent } from '../src/oauth/responses-websocket.js';
import { loadRegistryProviders } from '../src/registry/index.js';
import type { LocalProvider, LocalProviderModel } from '../src/types.js';

interface ProbeResult {
  mode: 'standalone' | 'context_management' | 'integrated_trigger';
  model: string;
  attempt: number;
  ok: boolean;
  outputItemTypes?: string[];
  sdkCompactionItems?: number;
  inputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  cacheReadRatio?: number;
  responseWireBytes?: number;
  triggerWireBytes?: number;
  eventTypes?: string[];
  upstreamErrorCode?: string;
  upstreamErrorCategory?: string;
  upstreamErrorMessageHash?: string;
  transportDecision?: string;
  incrementalInputItems?: number;
  errorType?: string;
  statusCode?: number;
}

interface WireSummary {
  wireBytes: number;
  eventTypes: string[];
  outputItemTypes: string[];
  assistantText: string;
  completed: boolean;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens?: number;
  };
  upstreamErrorCode?: string;
  upstreamErrorCategory?: string;
  upstreamErrorMessageHash?: string;
}

interface WireUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens?: number;
}

interface WireEvent {
  type?: string;
  delta?: string;
  item?: { type?: string };
  response?: { usage?: WireUsage };
  error?: { code?: string; message?: string };
}

interface ProbeHeaders {
  [key: string]: string;
  Authorization: string;
  originator: string;
}

type SyntheticInputItem = {
  role: 'user';
  content: Array<{ type: 'input_text'; text: string }>;
};

type ProbeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ProbeValue[]
  | ProbeRecord;

interface ProbeRecord {
  [key: string]: ProbeValue;
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === 'string';
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === 'number';
}

function isRecord<Value>(value: Value): value is Value & ProbeRecord {
  return Boolean(value) && typeof value === 'object';
}

function errorType<Value>(error: Value): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function errorStatusCode<Value>(error: Value): number | undefined {
  if (!isRecord(error) || !('statusCode' in error)) return undefined;
  return isNumber(error.statusCode) ? error.statusCode : undefined;
}

function summarizeWire(wire: string): WireSummary {
  const eventTypes: string[] = [];
  const itemTypes: string[] = [];
  let assistantText = '';
  let completed = false;
  let usage: WireSummary['usage'];
  let upstreamErrorCode: string | undefined;
  let upstreamErrorCategory: string | undefined;
  let upstreamErrorMessageHash: string | undefined;
  for (const line of wire.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    // SAFETY: Each SSE `data` field is an OpenAI response event envelope.
    const event = JSON.parse(line.slice(6)) as WireEvent;
    if (isString(event.type)) eventTypes.push(event.type);
    if (event.type === 'response.output_text.delta' && isString(event.delta)) {
      assistantText += event.delta;
    }
    if (
      event.type === 'response.output_item.done'
      && isString(event.item?.type)
    ) {
      itemTypes.push(event.item.type);
    }
    if (
      event.type === 'response.completed'
      && event.response
    ) {
      completed = true;
      usage = event.response.usage;
    }
    if (event.error) {
      const upstreamError = event.error;
      if (isString(upstreamError.code)) {
        upstreamErrorCode = upstreamError.code;
      }
      if (isString(upstreamError.message)) {
        const lower = upstreamError.message.toLowerCase();
        upstreamErrorCategory = lower.includes('context_management')
          ? 'context_management_rejected'
          : lower.includes('compaction_trigger')
            ? 'compaction_trigger_rejected'
            : lower.includes('rate limit') || lower.includes('rate_limit')
              ? 'rate_limited'
              : 'other';
        upstreamErrorMessageHash = createHash('sha256')
          .update(upstreamError.message)
          .digest('hex')
          .slice(0, 16);
      }
    }
  }
  return {
    wireBytes: Buffer.byteLength(wire),
    eventTypes: [...new Set(eventTypes)],
    outputItemTypes: itemTypes,
    assistantText,
    completed,
    usage,
    upstreamErrorCode,
    upstreamErrorCategory,
    upstreamErrorMessageHash,
  };
}

function outputItemTypes(output: unknown[]): string[] {
  return output.map(item => (
    isRecord(item) && 'type' in item && isString(item.type)
      ? item.type
      : 'unknown'
  ));
}

function openAiOAuthProvider(providers: LocalProvider[]): LocalProvider {
  const provider = providers.find(candidate => (
    candidate.authType === 'oauth'
    && candidate.models.some(model => model.npm === '@ai-sdk/openai')
  ));
  if (!provider?.apiKey) {
    throw new Error('No usable OpenAI OAuth provider was found in the clodex registry');
  }
  return provider;
}

function targetModels(provider: LocalProvider): LocalProviderModel[] {
  const ids = new Set(['gpt-5.6-sol', 'gpt-5.6-luna']);
  const models = provider.models.filter(model => (
    model.npm === '@ai-sdk/openai'
    && ids.has(model.upstreamModelId)
  ));
  if (models.length === 0) {
    throw new Error('Neither gpt-5.6-sol nor gpt-5.6-luna is available in the OpenAI OAuth provider');
  }
  return models;
}

function probeHeaders(provider: LocalProvider, model: LocalProviderModel): ProbeHeaders {
  const accountId = extractOpenAiAccountId({ access_token: provider.apiKey })?.trim()
    || provider.oauthAccountId?.trim();
  const headers: ProbeHeaders = {
    Authorization: `Bearer ${provider.apiKey}`,
    originator: 'clodex-compaction-probe',
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  if (model.useResponsesLite) {
    headers.version = CODEX_RESPONSES_LITE_VERSION;
    headers['x-openai-internal-codex-responses-lite'] = 'true';
  }
  return headers;
}

function syntheticInput(paragraphs = 180): [SyntheticInputItem] {
  const stableParagraph = [
    'This is synthetic cache-validation context for a local transport test.',
    'It contains no user files, prompts, account data, or conversation history.',
    'The compact endpoint should preserve the task state while reducing prior context.',
  ].join(' ');
  const text = Array.from({ length: paragraphs }, (_, index) => `${index + 1}. ${stableParagraph}`).join('\n');
  return [{
    role: 'user',
    content: [{
      type: 'input_text',
      text: `${text}\n\nTask state: respond to the next request using the retained synthetic context.`,
    }],
  }];
}

async function probeModel(
  provider: LocalProvider,
  model: LocalProviderModel,
  attempts: number,
): Promise<ProbeResult[]> {
  const input = syntheticInput();
  const promptCacheKey = `clodex-compaction-probe-${randomUUID()}`;
  const payload = {
    model: model.upstreamModelId,
    input,
    instructions: 'Compact the synthetic conversation state. Do not execute tools.',
    tools: [],
    parallel_tool_calls: false,
    reasoning: { effort: 'medium', context: model.useResponsesLite ? 'all_turns' : undefined },
    prompt_cache_key: promptCacheKey,
    text: { verbosity: 'low' },
  };
  const results: ProbeResult[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await compactResponsesWindow({
        requestUrl: 'https://chatgpt.com/backend-api/codex/responses',
        headers: probeHeaders(provider, model),
        payload,
      });
      const usage = result.usage;
      results.push({
        mode: 'standalone',
        model: model.upstreamModelId,
        attempt,
        ok: true,
        outputItemTypes: outputItemTypes(result.output),
        inputTokens: usage?.inputTokens,
        cachedTokens: usage?.cachedTokens,
        cacheWriteTokens: usage?.cacheWriteTokens,
        outputTokens: usage?.outputTokens,
        cacheReadRatio: usage?.inputTokens
          ? Number((usage.cachedTokens / usage.inputTokens).toFixed(4))
          : undefined,
      });
    } catch (error) {
      results.push({
        mode: 'standalone',
        model: model.upstreamModelId,
        attempt,
        ok: false,
        errorType: errorType(error),
        statusCode: errorStatusCode(error),
      });
      break;
    }
  }
  return results;
}

async function probeContextManagement(
  provider: LocalProvider,
  model: LocalProviderModel,
): Promise<ProbeResult> {
  const wsFetch = createResponsesWebSocketFetch(
    CODEX_RESPONSES_LITE_WS_URL,
    process.env.CLODEX_LIVE_COMPACTION_DEBUG === '1'
      ? message => process.stderr.write(`${message}\n`)
      : undefined,
    {
      providerId: provider.id,
      accountId: provider.oauthAccountId,
    },
  );
  // Production clodex has a listening server handle. The transport deliberately
  // unrefs idle sockets, so this standalone probe needs its own bounded handle.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const { Authorization: _authorization, ...headers } = probeHeaders(provider, model);
    const openai = createOpenAI({
      apiKey: provider.apiKey,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      headers,
      fetch: wsFetch,
    });
    const synthetic = syntheticInput()[0];
    const syntheticText = synthetic.content[0]?.text;
    if (!syntheticText) throw new Error('Synthetic compaction input is empty');
    const generated = streamText({
      model: openai.responses(model.upstreamModelId),
      system: 'Use native context management, then reply with the word OK.',
      prompt: syntheticText,
      maxRetries: 0,
      providerOptions: {
        openai: {
          store: false,
          promptCacheKey: `clodex-context-management-probe-${randomUUID()}`,
          reasoningEffort: 'medium',
          reasoningContext: model.useResponsesLite ? 'all_turns' : undefined,
          contextManagement: [{ type: 'compaction', compactThreshold: 1 }],
        } satisfies OpenAILanguageModelResponsesOptions,
      },
    });
    const [content, usage, finishReason] = await Promise.all([
      generated.content,
      generated.usage,
      generated.finishReason,
    ]);
    const compactionItems = content.filter(part => (
      part.type === 'custom' && part.kind === 'openai.compaction'
    ));
    const inputTokens = usage.inputTokens;
    const cachedTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    return {
      mode: 'context_management',
      model: model.upstreamModelId,
      attempt: 1,
      ok: finishReason !== 'error' && compactionItems.length > 0,
      outputItemTypes: content.map(part => (
        part.type === 'custom' ? part.kind : part.type
      )),
      sdkCompactionItems: compactionItems.length,
      inputTokens,
      cachedTokens,
      cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
      outputTokens: usage.outputTokens,
      cacheReadRatio: inputTokens
        ? Number((cachedTokens / inputTokens).toFixed(4))
        : undefined,
    };
  } catch (error) {
    return {
      mode: 'context_management',
      model: model.upstreamModelId,
      attempt: 1,
      ok: false,
      errorType: errorType(error),
      statusCode: errorStatusCode(error),
    };
  } finally {
    clearInterval(keepAlive);
  }
}

async function probeIntegratedCompaction(
  provider: LocalProvider,
  model: LocalProviderModel,
): Promise<ProbeResult> {
  const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
  const wsFetch = createResponsesWebSocketFetch(
    CODEX_RESPONSES_LITE_WS_URL,
    process.env.CLODEX_LIVE_COMPACTION_DEBUG === '1'
      ? message => process.stderr.write(`${message}\n`)
      : undefined,
    {
      providerId: provider.id,
      accountId: provider.oauthAccountId,
      compactThreshold: 1,
      onDiagnostic: event => diagnostics.push(event),
    },
  );
  const keepAlive = setInterval(() => {}, 1_000);
  const input = syntheticInput(40);
  const promptCacheKey = `clodex-compaction-trigger-probe-${randomUUID()}`;
  const basePayload = {
    model: model.upstreamModelId,
    instructions: 'Reply with the word OK.',
    tools: [],
    parallel_tool_calls: false,
    reasoning: { effort: 'medium', context: model.useResponsesLite ? 'all_turns' : undefined },
    prompt_cache_key: promptCacheKey,
    store: false,
  };
  try {
    const first = await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: probeHeaders(provider, model),
      body: JSON.stringify({ ...basePayload, input }),
    });
    const firstSummary = summarizeWire(await first.text());
    if (!firstSummary.completed || !firstSummary.assistantText) {
      return {
        mode: 'integrated_trigger',
        model: model.upstreamModelId,
        attempt: 1,
        ok: false,
        outputItemTypes: firstSummary.outputItemTypes,
        responseWireBytes: firstSummary.wireBytes,
        eventTypes: firstSummary.eventTypes,
        upstreamErrorCode: firstSummary.upstreamErrorCode,
        upstreamErrorCategory: firstSummary.upstreamErrorCategory,
        upstreamErrorMessageHash: firstSummary.upstreamErrorMessageHash,
      };
    }

    const assistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: firstSummary.assistantText }],
    };
    const second = await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: probeHeaders(provider, model),
      body: JSON.stringify({
        ...basePayload,
        input: [
          ...input,
          assistant,
          { role: 'user', content: [{ type: 'input_text', text: 'Continue with OK.' }] },
        ],
      }),
    });
    const secondSummary = summarizeWire(await second.text());
    const compaction = diagnostics.toReversed().find(event => (
      event.event === 'ws_compaction' && event.outcome === 'completed'
    ));
    const inputTokens = isNumber(compaction?.inputTokens) ? compaction.inputTokens : undefined;
    const cachedTokens = isNumber(compaction?.cachedTokens) ? compaction.cachedTokens : 0;
    const decision = diagnostics.toReversed().find(event => (
      event.event === 'ws_head_decision'
    ));
    return {
      mode: 'integrated_trigger',
      model: model.upstreamModelId,
      attempt: 1,
      ok: secondSummary.completed
        && compaction?.transport === 'previous_response_compaction_trigger'
        && decision?.decision === 'compaction_trigger_new_head',
      outputItemTypes: secondSummary.outputItemTypes,
      inputTokens,
      cachedTokens,
      cacheWriteTokens: isNumber(compaction?.cacheWriteTokens)
        ? compaction.cacheWriteTokens
        : 0,
      outputTokens: isNumber(compaction?.outputTokens)
        ? compaction.outputTokens
        : undefined,
      cacheReadRatio: inputTokens
        ? Number((cachedTokens / inputTokens).toFixed(4))
        : undefined,
      responseWireBytes: secondSummary.wireBytes,
      triggerWireBytes: isNumber(compaction?.triggerWireBytes)
        ? compaction.triggerWireBytes
        : undefined,
      eventTypes: secondSummary.eventTypes,
      upstreamErrorCode: secondSummary.upstreamErrorCode,
      upstreamErrorCategory: secondSummary.upstreamErrorCategory,
      upstreamErrorMessageHash: secondSummary.upstreamErrorMessageHash,
      transportDecision: isString(decision?.decision) ? decision.decision : undefined,
      incrementalInputItems: isNumber(decision?.incrementalInputItems)
        ? decision.incrementalInputItems
        : undefined,
    };
  } catch (error) {
    return {
      mode: 'integrated_trigger',
      model: model.upstreamModelId,
      attempt: 1,
      ok: false,
      errorType: errorType(error),
      statusCode: errorStatusCode(error),
    };
  } finally {
    clearInterval(keepAlive);
  }
}

async function main(): Promise<void> {
  if (process.env.CLODEX_LIVE_COMPACTION_PROBE !== '1') {
    throw new Error('Set CLODEX_LIVE_COMPACTION_PROBE=1 to authorize the live synthetic probe');
  }
  const providers = await loadRegistryProviders();
  const provider = openAiOAuthProvider(providers);
  const models = targetModels(provider);
  const results: ProbeResult[] = [];
  const mode = process.env.CLODEX_LIVE_COMPACTION_MODE ?? 'integrated_trigger';
  if (mode === 'all' || mode === 'standalone') {
    for (const model of models) {
      // The second identical Sol call validates prompt-cache reuse. Luna gets
      // one capability check to keep the live probe small.
      const attempts = model.upstreamModelId === 'gpt-5.6-sol' ? 2 : 1;
      results.push(...await probeModel(provider, model, attempts));
    }
  }
  const sol = models.find(model => model.upstreamModelId === 'gpt-5.6-sol');
  if (sol && (mode === 'all' || mode === 'context_management')) {
    results.push(await probeContextManagement(provider, sol));
  }
  if (sol && (mode === 'all' || mode === 'integrated_trigger')) {
    results.push(await probeIntegratedCompaction(provider, sol));
  }
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}

await main();
