import { describe, it, expect, vi } from 'bun:test';
import { streamText } from 'ai';
import {
  createLanguageModel,
  deepMergeProviderOptions,
  effortProviderOptions,
  getReasoningCapabilities,
  isSdkMigratedNpm,
  maxToolsForNpm,
  modelPrefersResponsesApi,
  shouldUseOpenAiResponsesEndpoint,
  thinkingProviderOptions,
} from '../src/provider-factory.js';
import { createXaiSubscriptionFetch } from '../src/oauth/xai-proxy.js';
import { restoreTestGlobals, stubTestGlobal } from './test-helpers.js';

async function expectCredentialHeadersStripped(
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const transport = vi.fn(async () => new Response(null, { status: 204 }));
  stubTestGlobal('fetch', transport);
  try {
    await fetchImpl('https://anonymous.example/v1/messages', {
      headers: {
        Authorization: 'Bearer configured-value',
        'X-API-Key': 'configured-value',
        Cookie: 'session=configured-value',
        'Proxy-Authorization': 'Bearer configured-value',
        'X-Auth-Token': 'configured-value',
        'X-Client-Secret': 'configured-value',
        'X-Credential-Id': 'configured-value',
        'Content-Type': 'application/json',
        'X-Custom': 'preserved',
        ...extraHeaders,
      },
    });

    // SAFETY: The test fixture defines the asserted runtime shape.
    const [, init] = transport.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    for (const name of [
      'authorization',
      'x-api-key',
      'cookie',
      'proxy-authorization',
      'x-auth-token',
      'x-client-secret',
      'x-credential-id',
    ]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-custom')).toBe('preserved');
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (![
        'authorization',
        'x-api-key',
        'cookie',
        'proxy-authorization',
        'x-auth-token',
        'x-client-secret',
        'x-credential-id',
      ].includes(name.toLowerCase())) {
        expect(headers.get(name)).toBe(value);
      }
    }
  } finally {
    restoreTestGlobals();
  }
}

describe('isSdkMigratedNpm', () => {
  it('returns true for any OpenCode-assigned npm except anthropic', () => {
    expect(isSdkMigratedNpm('@ai-sdk/openai')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/cerebras')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/perplexity')).toBe(true);
    expect(isSdkMigratedNpm('@openrouter/ai-sdk-provider')).toBe(true);
    expect(isSdkMigratedNpm('gitlab-ai-provider')).toBe(true);
  });

  it('returns false for anthropic passthrough and missing npm', () => {
    expect(isSdkMigratedNpm('@ai-sdk/anthropic')).toBe(false);
    expect(isSdkMigratedNpm(undefined)).toBe(false);
    expect(isSdkMigratedNpm('')).toBe(false);
  });
});

describe('modelPrefersResponsesApi', () => {
  it('detects OpenAI responses-only models', () => {
    expect(modelPrefersResponsesApi('gpt-5.5')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.5-fast')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-fast')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-sol')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-terra')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.6-luna')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-5.2-pro')).toBe(true);
    expect(modelPrefersResponsesApi('gpt-4o')).toBe(false);
    expect(modelPrefersResponsesApi('gpt-5.2')).toBe(false);
  });
});

describe('shouldUseOpenAiResponsesEndpoint', () => {
  it('defaults every OpenAI model to the Responses endpoint', () => {
    expect(shouldUseOpenAiResponsesEndpoint('gpt-4o')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-3.5-turbo')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-5.6-sol')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-7-does-not-exist-yet')).toBe(true);
  });

  it('keeps pre-chat legacy completion models on Chat Completions', () => {
    expect(shouldUseOpenAiResponsesEndpoint('davinci-002')).toBe(false);
    expect(shouldUseOpenAiResponsesEndpoint('babbage-002')).toBe(false);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-3.5-turbo-instruct')).toBe(false);
  });
});

describe('maxToolsForNpm', () => {
  it('caps Groq tool lists at 128', () => {
    expect(maxToolsForNpm('@ai-sdk/groq')).toBe(128);
  });

  it('does not cap non-Groq providers', () => {
    expect(maxToolsForNpm('@ai-sdk/openai')).toBeUndefined();
    expect(maxToolsForNpm(undefined)).toBeUndefined();
  });
});

describe('getReasoningCapabilities', () => {
  it('returns anthropic levels for claude-sonnet-4-6', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-sonnet-4-6');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.supportsSummaries).toBe(true);
  });

  it('returns empty levels for non-reasoning anthropic model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-haiku-4-5-20251001');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.supportsSummaries).toBe(false);
  });

  it('returns high/off only for mistral-large', () => {
    const caps = getReasoningCapabilities('@ai-sdk/mistral', 'mistral-large');
    expect(caps.levels).toEqual(['high', 'off']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('returns empty levels for unknown openai-compatible models', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'unknown');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
  });

  it('returns every documented GPT-5.6 effort level with the medium default', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai', 'gpt-5.6-sol');
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(caps.defaultLevel).toBe('medium');
  });

  it('returns the documented SuperGrok effort levels for Grok 4.6', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-4.6');
    expect(caps.levels).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('does not expose old Grok models', () => {
    expect(getReasoningCapabilities('@ai-sdk/xai', 'grok-4.5').levels).toEqual([]);
  });

  it('returns high/max/off for deepseek-v4-flash', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'deepseek-v4-flash');
    expect(caps.levels).toEqual(['high', 'max', 'off']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('returns documented GLM-5.2 reasoning levels for OpenAI-compatible routes', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'glm-5.2');
    expect(caps.levels).toEqual(['high', 'xhigh']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'openai-reasoning-effort' });
  });

  it('maps DeepSeek effort to openaiCompatible reasoningEffort + thinking enabled', () => {
    const merged = deepMergeProviderOptions(
      effortProviderOptions('@ai-sdk/openai-compatible', 'max', 'deepseek-v4-flash'),
    );
    expect(merged?.openaiCompatible).toMatchObject({ reasoningEffort: 'max' });
    expect(merged?.deepseek).toMatchObject({ thinking: { type: 'enabled' } });
  });

  it('maps Claude low effort to DeepSeek high', () => {
    const opts = effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'deepseek-v4-pro');
    expect(opts?.openaiCompatible).toMatchObject({ reasoningEffort: 'high' });
  });

  it('maps GLM-5.2 effort to OpenAI-compatible reasoningEffort', () => {
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'xhigh', 'glm-5.2')).toEqual({
      openaiCompatible: { reasoningEffort: 'max' },
    });
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'glm-5.2')).toBeUndefined();
  });
});

describe('effortProviderOptions + deepMergeProviderOptions', () => {
  it.each(['none', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'preserves GPT-5.6 %s effort on the OpenAI wire',
    (effort) => {
      expect(effortProviderOptions('@ai-sdk/openai', effort, 'gpt-5.6-sol')).toEqual({
        openai: { reasoningEffort: effort },
      });
    },
  );

  it('keeps GPT-5.5 outside the GPT-5.6 wire-effort scope', () => {
    expect(effortProviderOptions('@ai-sdk/openai', 'xhigh', 'gpt-5.5')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  it('leaves the reasoning summary untouched for other Codex models', () => {
    expect(effortProviderOptions('@ai-sdk/openai', 'high', 'gpt-5.1-codex-max')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  it('merges OpenAI thinking + effort without dropping store/include', () => {
    const merged = deepMergeProviderOptions(
      thinkingProviderOptions('@ai-sdk/openai'),
      effortProviderOptions('@ai-sdk/openai', 'high', 'gpt-5.4'),
    );
    expect(merged?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
  });

  it('keeps Grok 4.6 reasoning replay private and preserves each effort level', () => {
    expect(thinkingProviderOptions('@ai-sdk/xai')).toEqual({ xai: { store: false } });
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      expect(effortProviderOptions('@ai-sdk/xai', effort, 'grok-4.6')).toEqual({
        xai: { reasoningEffort: effort },
      });
    }
  });

});

describe('createLanguageModel', () => {
  it('surfaces only the accepted native Grok recovery through SDK stream parts', async () => {
    const events = [
      {
        type: 'response.created',
        response: {
          id: 'resp-grok-live', created_at: 1, model: 'grok-4.6', object: 'response',
          output: [], status: 'in_progress',
        },
      },
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'reasoning-1', output_index: 0, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'reasoning-1', output_index: 0, summary_index: 0,
        delta: 'working through it',
      },
      {
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'reasoning', id: 'reasoning-1', status: 'completed',
          summary: [{ type: 'summary_text', text: 'working through it' }],
          content: null, encrypted_content: null,
        },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'message-1', output_index: 1, content_index: 0,
        delta: 'finished answer',
      },
      {
        type: 'response.output_text.done',
        item_id: 'message-1', output_index: 1, content_index: 0,
        text: 'finished answer', annotations: [], logprobs: [],
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp-grok-live', created_at: 1, model: 'grok-4.6', object: 'response',
          output: [], status: 'completed',
          usage: {
            input_tokens: 10, output_tokens: 5, total_tokens: 15,
            input_tokens_details: { cached_tokens: 8 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      },
    ];
    const responseBody = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    const poisonedBody = [
      events[0],
      events[1],
      { ...events[2], delta: 'poisoned thought' },
      {
        type: 'response.doom_loop_check',
        doom_loop_check: { triggers: ['tail_repetition:8@thinking'] },
      },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    const transport = vi.fn()
      .mockResolvedValueOnce(new Response(poisonedBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
    const xaiFetch = createXaiSubscriptionFetch(
      'grok-4.6',
      'session-live-parts',
      // SAFETY: The test fixture defines the asserted runtime shape.
      transport as typeof fetch,
      { random: () => 0, sleep: async () => {} },
    );
    const model = await createLanguageModel({
      npm: '@ai-sdk/xai',
      modelId: 'grok-4.6',
      apiKey: 'subscription-token',
      authType: 'oauth',
      providerId: 'xai-oauth',
      claudeSessionId: 'session-live-parts',
    }, {
      // SAFETY: The test fixture defines the asserted runtime shape.
      createXaiSubscriptionFetch: vi.fn(() => xaiFetch as typeof fetch) as never,
    });

    const streamed = streamText({ model, prompt: 'test live Grok reasoning', maxRetries: 0 });
    const partTypes: string[] = [];
    let reasoning = '';
    let text = '';
    for await (const part of streamed.stream) {
      partTypes.push(part.type);
      if (part.type === 'reasoning-delta') reasoning += part.text;
      if (part.type === 'text-delta') text += part.text;
    }

    expect(partTypes).toContain('reasoning-start');
    expect(partTypes).toContain('reasoning-delta');
    expect(partTypes).toContain('text-start');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(reasoning).toBe('working through it');
    expect(reasoning).not.toContain('poisoned');
    expect(text).toBe('finished answer');
  });

  it('routes only Grok 4.6 OAuth through the SuperGrok Responses proxy', async () => {
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'xai-responses' }));
    const createXai = vi.fn(() => ({ responses }));
    const xaiFetch = vi.fn();
    const createXaiFetch = vi.fn(() => xaiFetch);

    const model = await createLanguageModel({
      npm: '@ai-sdk/xai',
      modelId: 'grok-4.6',
      apiKey: 'subscription-token',
      authType: 'oauth',
      providerId: 'xai-oauth',
      claudeSessionId: 'session-123',
    }, {
      // SAFETY: The test fixture defines the asserted runtime shape.
      createXai: createXai as never,
      // SAFETY: The test fixture defines the asserted runtime shape.
      createXaiSubscriptionFetch: createXaiFetch as never,
    });

    expect(createXaiFetch).toHaveBeenCalledWith('grok-4.6', 'session-123');
    expect(createXai).toHaveBeenCalledWith({
      apiKey: 'subscription-token',
      baseURL: 'https://cli-chat-proxy.grok.com/v1',
      fetch: xaiFetch,
    });
    expect(responses).toHaveBeenCalledWith('grok-4.6');
    // SAFETY: The test fixture defines the asserted runtime shape.
    expect(model).toEqual({ modelId: 'grok-4.6', provider: 'xai-responses' } as never);
  });

  it('rejects xAI API keys and old Grok models', async () => {
    await expect(createLanguageModel({
      npm: '@ai-sdk/xai',
      modelId: 'grok-4.6',
      apiKey: 'api-key',
      authType: 'api',
      providerId: 'xai',
    })).rejects.toThrow('API-key access is not supported');

    await expect(createLanguageModel({
      npm: '@ai-sdk/xai',
      modelId: 'grok-4.5',
      apiKey: 'subscription-token',
      authType: 'oauth',
      providerId: 'xai-oauth',
    })).rejects.toThrow('only grok-4.6');
  });

  it('passes the resolved native-compaction threshold into the OAuth transport', async () => {
    const responsesFetch = vi.fn();
    const createResponsesWebSocketFetch = vi.fn(() => responsesFetch);
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    const create = (spec: Parameters<typeof createLanguageModel>[0]) => createLanguageModel(spec, {
      // SAFETY: The test fixture defines the asserted runtime shape.
      createOpenAI: createOpenAI as never,
      // SAFETY: The test fixture defines the asserted runtime shape.
      createResponsesWebSocketFetch: createResponsesWebSocketFetch as never,
    });
    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.6-sol',
      apiKey: 'oauth-token',
      authType: 'oauth',
      oauthAccountId: 'acct-transport-threshold',
      openAiCompactThreshold: 244_800,
      openAiContextWindow: 272_000,
    });

    expect(createResponsesWebSocketFetch).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        accountId: 'acct-transport-threshold',
        compactThreshold: 244_800,
        contextWindow: 272_000,
        checkpointStoreDir: expect.any(String),
      }),
    );
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      fetch: responsesFetch,
    }));

    await create({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.6-sol',
      apiKey: 'oauth-token',
      authType: 'oauth',
      oauthAccountId: 'acct-compaction-disabled',
    });
    expect(createResponsesWebSocketFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        compactThreshold: undefined,
        checkpointStoreDir: undefined,
      }),
    );
  });

  it('prefers the current OpenAI OAuth token account claim over stored metadata', async () => {
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));

    const header = Buffer.from('{}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct-123' })).toString('base64url');
    const accessToken = `${header}.${payload}.sig`;

    await createLanguageModel({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.5',
      apiKey: accessToken,
      authType: 'oauth',
      oauthAccountId: 'stored-acct-456',
    }, { createOpenAI: /* SAFETY: The mock implements the required provider factory. */ createOpenAI as never });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: accessToken,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      fetch: expect.any(Function),
      headers: {
        'ChatGPT-Account-Id': 'acct-123',
        originator: 'clodex',
      },
    });
    expect(responses).toHaveBeenCalledWith('gpt-5.5');
  });

  it('falls back to the stored OpenAI account id when the current token has no account claim', async () => {
    const responses = vi.fn((modelId: string) => ({
      modelId,
      provider: 'openai-responses',
    }));
    const chat = vi.fn((modelId: string) => ({
      modelId,
      provider: 'openai-chat',
    }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));

    await createLanguageModel({
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.5',
      apiKey: 'opaque-access-token',
      authType: 'oauth',
      oauthAccountId: 'stored-acct-456',
    }, { createOpenAI: /* SAFETY: The mock implements the required provider factory. */ createOpenAI as never });

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'ChatGPT-Account-Id': 'stored-acct-456',
        }),
      }),
    );
  });

  it('installs credential-header stripping for anonymous OpenAI providers', async () => {
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));

    await createLanguageModel({
      npm: '@ai-sdk/openai',
      modelId: 'anonymous-model',
      apiKey: '',
      authType: 'none',
      headers: {
        Authorization: 'Bearer configured-value',
        'X-Plan': 'free',
      },
    }, { createOpenAI: /* SAFETY: The mock implements the required provider factory. */ createOpenAI as never });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: '',
      headers: {
        Authorization: 'Bearer configured-value',
        'X-Plan': 'free',
      },
      fetch: expect.any(Function),
    });
    expect(responses).toHaveBeenCalledWith('anonymous-model');
    // SAFETY: The test fixture defines the asserted runtime shape.
    const options = createOpenAI.mock.calls[0]?.[0] as {
      fetch: typeof fetch;
      headers: Record<string, string>;
    };
    await expectCredentialHeadersStripped(options.fetch, options.headers);
  });

  it('forwards configured headers for authenticated OpenAI providers', async () => {
    const responses = vi.fn((modelId: string) => ({ modelId, provider: 'openai-responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, provider: 'openai-chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));

    await createLanguageModel({
      npm: '@ai-sdk/openai',
      modelId: 'authenticated-model',
      apiKey: 'provider-key',
      authType: 'api',
      headers: { 'X-Plan': 'paid' },
    }, { createOpenAI: /* SAFETY: The mock implements the required provider factory. */ createOpenAI as never });

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'provider-key',
      headers: { 'X-Plan': 'paid' },
    });
    expect(responses).toHaveBeenCalledWith('authenticated-model');
  });

  it('ignores discovery baseURL for @ai-sdk/anthropic (SDK default includes /v1)', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId, provider: 'anthropic' }));
    const createAnthropic = vi.fn(() => anthropicFactory);

    await createLanguageModel({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
    }, { createAnthropic: /* SAFETY: The mock implements the required provider factory. */ createAnthropic as never });

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(createAnthropic).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.anthropic.com' }),
    );
  });

  it('normalizes custom anthropic baseURL to include /v1', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);

    await createLanguageModel({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com',
    }, { createAnthropic: /* SAFETY: The mock implements the required provider factory. */ createAnthropic as never });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://proxy.example.com/v1',
    });
  });

  it('routes Claude Code Anthropic OAuth through Bearer auth with compatibility headers', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId, provider: 'anthropic-oauth' }));
    const createAnthropic = vi.fn(() => anthropicFactory);

    await createLanguageModel({
      npm: '@ai-sdk/anthropic',
      modelId: 'claude-sonnet-4-6',
      apiKey: 'oauth-token',
      authType: 'oauth',
      providerId: 'claude-code',
      oauthAccountId: '11111111-1111-4111-8111-111111111111',
    }, { createAnthropic: /* SAFETY: The mock implements the required provider factory. */ createAnthropic as never });

    expect(createAnthropic).toHaveBeenCalledWith({
      authToken: 'oauth-token',
      headers: expect.objectContaining({
        'User-Agent': 'claude-cli/2.1.195 (external, cli)',
        'x-app': 'cli',
        'X-Claude-Code-Session-Id': expect.any(String),
      }),
    });
    expect(createAnthropic).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'oauth-token' }),
    );
    expect(anthropicFactory).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('forwards custom headers for openai-compatible custom endpoints', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);

    await createLanguageModel({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'glm-5.2',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      providerId: 'custom-zai',
      headers: { 'X-Plan': 'coding' },
    }, { createOpenAICompatible: /* SAFETY: The mock implements the required provider factory. */ createOpenAICompatible as never });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'custom-zai',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      headers: { 'X-Plan': 'coding' },
    });
  });

  it('omits apiKey for anonymous openai-compatible providers', async () => {
    const factory = vi.fn((modelId: string) => ({ modelId }));
    const createOpenAICompatible = vi.fn(() => factory);

    await createLanguageModel({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'tencent/hy3:free',
      apiKey: '',
      authType: 'none',
      baseURL: 'https://api.kilo.ai/api/gateway',
      providerId: 'kilo',
    }, { createOpenAICompatible: /* SAFETY: The mock implements the required provider factory. */ createOpenAICompatible as never });

    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'kilo',
      baseURL: 'https://api.kilo.ai/api/gateway',
      fetch: expect.any(Function),
    });
    // SAFETY: The test fixture defines the asserted runtime shape.
    const options = createOpenAICompatible.mock.calls[0]?.[0] as { fetch: typeof fetch };
    await expectCredentialHeadersStripped(options.fetch);
  });

  it('strips generated credential headers for anonymous Anthropic providers', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);

    await createLanguageModel({
      npm: '@ai-sdk/anthropic',
      modelId: 'anonymous-model',
      apiKey: '',
      authType: 'none',
      baseURL: 'https://anonymous.example',
    }, { createAnthropic: /* SAFETY: The mock implements the required provider factory. */ createAnthropic as never });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: '',
      baseURL: 'https://anonymous.example/v1',
      fetch: expect.any(Function),
    });
    expect(anthropicFactory).toHaveBeenCalledWith('anonymous-model');

    // SAFETY: The test fixture defines the asserted runtime shape.
    const options = createAnthropic.mock.calls[0]?.[0] as { fetch: typeof fetch };
    await expectCredentialHeadersStripped(options.fetch);
  });

  it('merges custom headers into a non-OAuth custom anthropic endpoint', async () => {
    const anthropicFactory = vi.fn((modelId: string) => ({ modelId }));
    const createAnthropic = vi.fn(() => anthropicFactory);

    await createLanguageModel({
      npm: '@ai-sdk/anthropic',
      modelId: 'glm-5.2',
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/anthropic',
      headers: { 'X-Plan': 'coding' },
    }, { createAnthropic: /* SAFETY: The mock implements the required provider factory. */ createAnthropic as never });

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://api.z.ai/api/anthropic/v1',
      headers: { 'X-Plan': 'coding' },
    });
  });
});
