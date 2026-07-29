import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_RESPONSES_LITE_VERSION,
  CODEX_RESPONSES_LITE_WS_URL,
} from '../src/constants.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
import {
  createResponsesWebSocketFetch,
  resetResponsesWebSocketConnectionsForTests,
  withResponsesWebSocketDiagnosticContext,
} from '../src/oauth/responses-websocket.js';
import { loadRegistryProviders } from '../src/registry/index.js';
import type { LocalProvider, LocalProviderModel } from '../src/types.js';

interface JsonObject {
  [key: string]: unknown;
}

interface WireSummary {
  completed: boolean;
  output: unknown[];
  assistantText: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  errorCode?: string;
  errorMessageHash?: string;
}

function summarizeWire(wire: string): WireSummary {
  const output: unknown[] = [];
  let completed = false;
  let assistantText = '';
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let errorCode: string | undefined;
  let errorMessageHash: string | undefined;
  for (const line of wire.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6)) as JsonObject;
    if (event.type === 'response.output_item.done' && event.item !== undefined) {
      output.push(event.item);
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      assistantText += event.delta;
    }
    if (
      event.type === 'response.completed'
      && event.response
      && typeof event.response === 'object'
    ) {
      completed = true;
      const usage = (event.response as JsonObject).usage as JsonObject | undefined;
      inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
      outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
      const details = usage?.input_tokens_details as JsonObject | undefined;
      cachedTokens = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
    }
    if (event.error && typeof event.error === 'object') {
      const error = event.error as JsonObject;
      errorCode = typeof error.code === 'string' ? error.code : undefined;
      if (typeof error.message === 'string') {
        errorMessageHash = createHash('sha256')
          .update(error.message)
          .digest('hex')
          .slice(0, 16);
      }
    }
  }
  return {
    completed,
    output,
    assistantText,
    inputTokens,
    cachedTokens,
    outputTokens,
    errorCode,
    errorMessageHash,
  };
}

function oauthProvider(providers: LocalProvider[]): LocalProvider {
  const provider = providers.find(candidate => (
    candidate.authType === 'oauth'
    && candidate.models.some(model => model.upstreamModelId === 'gpt-5.3-codex-spark')
  ));
  if (!provider?.apiKey) throw new Error('No OpenAI OAuth provider with Spark is configured');
  return provider;
}

function sparkModel(provider: LocalProvider): LocalProviderModel {
  const model = provider.models.find(candidate => (
    candidate.upstreamModelId === 'gpt-5.3-codex-spark'
  ));
  if (!model) throw new Error('Spark is not configured');
  return model;
}

function headers(provider: LocalProvider, model: LocalProviderModel): Record<string, string> {
  const accountId = extractOpenAiAccountId({ access_token: provider.apiKey })?.trim()
    || provider.oauthAccountId?.trim();
  return {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    originator: 'clodex-overflow-recovery-probe',
    ...(model.useResponsesLite
      ? {
          version: CODEX_RESPONSES_LITE_VERSION,
          'x-openai-internal-codex-responses-lite': 'true',
        }
      : {}),
  };
}

function syntheticRecords(label: string, count: number): string {
  return Array.from({ length: count }, (_, index) => (
    `${label} record ${index + 1}: This synthetic history contains ordinary language only. `
    + 'Retain the current task, completed checks, relevant constraints, and latest tool state. '
    + 'Older repeated narrative may be compacted safely. No user files, private prompts, '
    + 'credentials, account data, or external actions are included in this isolated probe.'
  )).join('\n');
}

function withoutEphemeralFields(item: JsonObject): JsonObject {
  const normalized = { ...item };
  delete normalized.id;
  delete normalized.status;
  delete normalized.phase;
  delete normalized.role;
  for (const [key, value] of Object.entries(normalized)) {
    if (value == null) delete normalized[key];
  }
  return normalized;
}

function claudeRoundTrippedAssistant(items: unknown[]): unknown[] {
  const assistant: unknown[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as JsonObject;
    if (record.type === 'message') {
      const content = Array.isArray(record.content) ? record.content : [];
      const text = content
        .filter(part => part && typeof part === 'object' && (part as JsonObject).type === 'output_text')
        .map(part => String((part as JsonObject).text ?? ''))
        .join('');
      assistant.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      continue;
    }
    if (
      record.type === 'reasoning'
      || record.type === 'function_call'
      || record.type === 'custom_tool_call'
      || record.type === 'compaction'
      || record.type === 'compaction_summary'
    ) {
      assistant.push({ ...withoutEphemeralFields(record), type: record.type });
    }
  }
  return assistant;
}

function requestPayload(
  model: LocalProviderModel,
  promptCacheKey: string,
  input: unknown[],
): JsonObject {
  return {
    model: model.upstreamModelId,
    input,
    instructions: [
      'If the latest user request asks to run the synthetic probe and no result exists,',
      'call synthetic_overflow_probe exactly once with an empty object.',
      'After its result exists, reply with exactly RECOVERED and do not call another tool.',
    ].join(' '),
    tools: [{
      type: 'function',
      name: 'synthetic_overflow_probe',
      description: 'Returns synthetic context used only by an isolated transport probe.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      strict: true,
    }],
    parallel_tool_calls: false,
    tool_choice: 'auto',
    reasoning: { effort: 'low' },
    prompt_cache_key: promptCacheKey,
    text: { verbosity: 'low' },
    store: false,
  };
}

async function main(): Promise<void> {
  if (process.env.CLODEX_LIVE_OVERFLOW_PROBE !== '1') {
    throw new Error('Set CLODEX_LIVE_OVERFLOW_PROBE=1 to authorize the live synthetic probe');
  }

  // Resolve the existing credential once. Every transport/checkpoint resource
  // created after this point is process-local or rooted in this temporary home.
  const provider = oauthProvider(await loadRegistryProviders());
  const model = sparkModel(provider);
  const isolatedHome = mkdtempSync(join(tmpdir(), 'clodex-live-overflow-'));
  const checkpointStoreDir = join(isolatedHome, 'checkpoints');
  const diagnostics: JsonObject[] = [];
  const compactRequestSizes: Array<{ items: number; bytes: number }> = [];
  const compactFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const parsed = body ? JSON.parse(body) as JsonObject : {};
    const compactInput = Array.isArray(parsed.input) ? parsed.input : [];
    compactRequestSizes.push({
      items: compactInput.length,
      bytes: Buffer.byteLength(JSON.stringify(compactInput)),
    });
    return fetch(input, init);
  }) as typeof fetch;
  const wsFetch = createResponsesWebSocketFetch(
    CODEX_RESPONSES_LITE_WS_URL,
    process.env.CLODEX_LIVE_COMPACTION_DEBUG === '1'
      ? message => process.stderr.write(`${message}\n`)
      : undefined,
    {
      providerId: provider.id,
      accountId: `${provider.oauthAccountId ?? 'oauth'}:isolated-overflow-probe`,
      compactThreshold: 115_200,
      contextWindow: 128_000,
      compactFetch,
      checkpointStoreDir,
      onDiagnostic: event => diagnostics.push(event),
    },
  );
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const promptCacheKey = `clodex-overflow-recovery-${randomUUID()}`;
    const claudeSessionId = `live-overflow-session-${randomUUID()}`;
    const claudeAgentId = `workflow-spark-${randomUUID()}`;
    const initialInput = Array.from({ length: 10 }, (_, index) => {
      const user = {
        role: 'user',
        content: [{
          type: 'input_text',
          text: [
            syntheticRecords(`prefix-${index + 1}`, 150),
            ...(index === 9 ? ['Run the synthetic probe tool now.'] : []),
          ].join('\n\n'),
        }],
      };
      return index === 9
        ? [user]
        : [
            user,
            {
              role: 'assistant',
              content: [{
                type: 'output_text',
                text: `Acknowledged synthetic history segment ${index + 1}.`,
              }],
            },
          ];
    }).flat();
    const first = await withResponsesWebSocketDiagnosticContext(
      {
        estimatedInputTokens: 60_000,
        claudeSessionId,
        claudeAgentId,
      },
      () => wsFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: headers(provider, model),
        body: JSON.stringify(requestPayload(model, promptCacheKey, initialInput)),
      }),
    );
    const firstSummary = summarizeWire(await first.text());
    const assistant = claudeRoundTrippedAssistant(firstSummary.output);
    const call = assistant.find(item => (
      item
      && typeof item === 'object'
      && (item as JsonObject).type === 'function_call'
      && typeof (item as JsonObject).call_id === 'string'
    )) as JsonObject | undefined;
    if (!firstSummary.completed || !call || typeof call.call_id !== 'string') {
      throw new Error(
        `Initial Spark tool turn failed (${firstSummary.errorCode ?? 'missing function call'}, `
        + `${firstSummary.errorMessageHash ?? 'no error hash'})`,
      );
    }

    const toolOutput = {
      type: 'function_call_output',
      call_id: call.call_id,
      output: syntheticRecords('tool-output', 1_000),
    };
    const fullInput = [...initialInput, ...assistant, toolOutput];
    const fullInputBytes = Buffer.byteLength(JSON.stringify(fullInput));
    const second = await withResponsesWebSocketDiagnosticContext(
      {
        estimatedInputTokens: 150_000,
        claudeSessionId,
        claudeAgentId,
      },
      () => wsFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: headers(provider, model),
        body: JSON.stringify(requestPayload(model, promptCacheKey, fullInput)),
      }),
    );
    const secondSummary = summarizeWire(await second.text());
    const recovery = [...diagnostics].reverse().find(event => (
      event.event === 'ws_overflow_recovery' && event.outcome === 'completed'
    ));
    const secondDecision = [...diagnostics].reverse().find(event => event.event === 'ws_head_decision');
    const compactCallsAfterRecovery = compactRequestSizes.length;
    const recoveredAssistant = claudeRoundTrippedAssistant(secondSummary.output);
    const thirdInput = [
      ...fullInput,
      ...recoveredAssistant,
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue after recovery with exactly RECOVERED.' }],
      },
    ];
    const third = await withResponsesWebSocketDiagnosticContext(
      {
        estimatedInputTokens: 155_000,
        claudeSessionId,
        claudeAgentId,
      },
      () => wsFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: headers(provider, model),
        body: JSON.stringify(requestPayload(model, promptCacheKey, thirdInput)),
      }),
    );
    const thirdSummary = summarizeWire(await third.text());
    const thirdDecision = [...diagnostics].reverse().find(event => event.event === 'ws_head_decision');
    const result = {
      isolated: true,
      model: model.upstreamModelId,
      first: {
        completed: firstSummary.completed,
        inputTokens: firstSummary.inputTokens,
        cachedTokens: firstSummary.cachedTokens,
        outputTokens: firstSummary.outputTokens,
      },
      oversizedTurn: {
        httpStatus: second.status,
        estimatedInputTokens: 150_000,
        fullInputItems: fullInput.length,
        fullInputBytes,
        completed: secondSummary.completed,
        inputTokens: secondSummary.inputTokens,
        cachedTokens: secondSummary.cachedTokens,
        outputTokens: secondSummary.outputTokens,
        errorCode: secondSummary.errorCode,
        errorMessageHash: secondSummary.errorMessageHash,
        assistantText: secondSummary.assistantText,
      },
      recovery: recovery
        ? {
            source: recovery.source,
            reason: recovery.reason,
            prefixItems: recovery.prefixItems,
            tailItems: recovery.tailItems,
            rebasedItems: recovery.rebasedItems,
            estimatedRebasedTokens: recovery.estimatedRebasedTokens,
            attemptCount: recovery.attemptCount,
          }
        : undefined,
      recoveryDecision: secondDecision?.decision,
      nextTurn: {
        httpStatus: third.status,
        completed: thirdSummary.completed,
        assistantText: thirdSummary.assistantText,
        inputTokens: thirdSummary.inputTokens,
        cachedTokens: thirdSummary.cachedTokens,
        outputTokens: thirdSummary.outputTokens,
        decision: thirdDecision?.decision,
        additionalCompactCalls: compactRequestSizes.length - compactCallsAfterRecovery,
      },
      compactRequestSizes,
      overflowDiagnostics: diagnostics.filter(event => event.event === 'ws_overflow_recovery'),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (
      !secondSummary.completed
      || secondSummary.assistantText.trim() !== 'RECOVERED'
      || !recovery
      || recovery.reason !== 'known_oversized'
      || compactRequestSizes.length !== 1
      || compactRequestSizes[0]!.bytes >= fullInputBytes
      || !thirdSummary.completed
      || thirdSummary.assistantText.trim() !== 'RECOVERED'
      || thirdDecision?.decision !== 'continuation'
      || compactRequestSizes.length !== compactCallsAfterRecovery
    ) {
      process.exitCode = 1;
    }
  } finally {
    clearInterval(keepAlive);
    resetResponsesWebSocketConnectionsForTests();
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

await main();
