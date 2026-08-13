import { describe, it, expect, vi } from 'bun:test';
import {
  annotateToolNames,
  anthropicEffortFromRequest,
  translateMessages,
  translateTools,
  translateToolChoice,
  translateRequest,
  writeAnthropicStream,
  streamAnthropicResponse,
  supportsOpenAiPromptCacheBreakpoints,
  extractClaudeSessionId,
  claudeSessionPromptCacheKey,
  isClaudeCodeCompactRequest,
  isClaudeCodeStructuredOutputCompactRequest,
  sdkTranslationErrorSignature,
  generateAnthropicResponse,
} from '../src/sdk-adapter.js';

const OPENAI_STEERING_POLICY_FOR_TESTS = [
  'The user may send a new message while you are still working. When they do, evaluate whether',
  'they intended to replace the active request or add to it. If they intended to override or',
  'replace it, drop the previous work and focus on the new request. If the new message adds to',
  'unfinished work, address both. If it asks for status or another question, answer it and then',
  'continue only the work that remains relevant.',
].join(' ');

describe('sdkTranslationErrorSignature', () => {
  it('classifies missing stream parts without exposing their dynamic ids', () => {
    expect(sdkTranslationErrorSignature(new Error('reasoning part reasoning-42 not found')))
      .toBe('reasoning_part_not_found');
    expect(sdkTranslationErrorSignature('text part msg-sensitive not found'))
      .toBe('text_part_not_found');
    expect(sdkTranslationErrorSignature(new Error('rate limited'))).toBeUndefined();
  });
});

describe('supportsOpenAiPromptCacheBreakpoints', () => {
  it('enables GPT-5.6 and later OpenAI generations only', () => {
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-5.5')).toBe(false);
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-5.6-sol')).toBe(true);
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-5.10')).toBe(true);
    expect(supportsOpenAiPromptCacheBreakpoints('gpt-6')).toBe(true);
    expect(supportsOpenAiPromptCacheBreakpoints('grok-5.6')).toBe(false);
  });
});

describe('translateTools', () => {
  it('builds client-side tools (no execute) keyed by name', () => {
    const tools = translateTools([
      { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
    expect(tools && Object.keys(tools)).toEqual(['Read']);
    expect(tools!.Read.execute).toBeUndefined();
  });
  it('returns undefined for empty/missing tools', () => {
    expect(translateTools(undefined)).toBeUndefined();
    expect(translateTools([])).toBeUndefined();
  });

  it('maps Anthropic server web search to the OpenAI provider tool', () => {
    const tools = translateTools([{
      type: 'web_search_20260209',
      name: 'web_search',
      allowed_domains: ['openai.com'],
      user_location: { type: 'approximate', country: 'US', timezone: 'America/Chicago' },
    }], '@ai-sdk/openai');

    expect(tools?.web_search).toMatchObject({
      type: 'provider',
      id: 'openai.web_search',
      args: {
        filters: { allowedDomains: ['openai.com'] },
        userLocation: { type: 'approximate', country: 'US', timezone: 'America/Chicago' },
      },
    });
  });

  it('keeps client tools named web_search as ordinary functions', () => {
    const tools = translateTools([{
      name: 'web_search',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    }], '@ai-sdk/openai');
    expect(tools?.web_search).not.toHaveProperty('id');
    expect(tools?.web_search.execute).toBeUndefined();
  });

  it('rejects server web-search exclusions that OpenAI cannot enforce', () => {
    expect(() => translateTools([{
      type: 'web_search_20260209',
      name: 'web_search',
      blocked_domains: ['example.com'],
    }], '@ai-sdk/openai')).toThrow('does not support blocked_domains');
  });
});

describe('annotateToolNames', () => {
  it('resolves tool_result names from prior tool_use ids', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hi' }] },
    ];
    annotateToolNames(messages);
    expect((messages[1].content as any[])[0]._name).toBe('Read');
  });
  it('resolves names even when the id carries an encoded thought signature', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1__ts__U0lH', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_1__ts__U0lH', content: 'hi' }] },
    ];
    annotateToolNames(messages);
    expect((messages[1].content as any[])[0]._name).toBe('Read');
  });
});

describe('translateMessages', () => {
  it('maps user text and assistant text', () => {
    const out = translateMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ], '@ai-sdk/xai');
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]);
  });

  it('maps Claude mid-turn steering to an explicit final user instruction for OpenAI OAuth', () => {
    const queued = 'The user sent a new message while you were working:\n'
      + 'update the pull request description with these results\n\n'
      + 'This is how Claude Code surfaces messages the user sends mid-turn — within the running '
      + 'turn, often alongside the next tool result, rather than as a separate conversation turn. '
      + 'Address the message above as you continue this turn.';
    const params = translateRequest({
      model: 'sol',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'benchmark complete' },
          { type: 'text', text: queued },
        ],
      }],
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect((params.messages as any[]).map(message => message.role)).toEqual([
      'tool',
      'user',
    ]);
    expect((params.messages[1] as any).content[0].text).toBe([
      'The user sent this new instruction while the current task was running.',
      'Treat it as the newest user request and apply it now before continuing earlier work.',
      'If it replaces, redirects, limits, or stops prior work, follow it immediately.',
      '',
      'update the pull request description with these results',
    ].join('\n'));
    expect(params.providerOptions?.openai?.instructions).toContain(
      'If they intended to override or replace it, drop the previous work',
    );
  });

  it('uses one stable steering policy without adding inline control messages', () => {
    const params = translateRequest({
      model: 'sol',
      messages: [{ role: 'user', content: 'continue the existing plan' }],
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect((params.messages as any[]).map(message => message.role)).toEqual(['user']);
    expect((params.messages[0] as any).content[0].text).toBe('continue the existing plan');
    expect(params.providerOptions?.openai?.instructions).toContain(
      'The user may send a new message while you are still working.',
    );
  });

  it('puts exact steering wrappers after ordinary content in the same user message', () => {
    const queued = 'The user sent a new message while you were working:\n'
      + 'focus only on the failing test\n\n'
      + 'This is how Claude Code surfaces messages the user sends mid-turn — within the running '
      + 'turn, often alongside the next tool result, rather than as a separate conversation turn. '
      + 'Address the message above as you continue this turn.';
    const params = translateRequest({
      model: 'sol',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: queued },
          { type: 'text', text: 'tool context that arrived in the same boundary' },
        ],
      }],
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect((params.messages[0] as any).content.map((part: any) => part.text)).toEqual([
      'tool context that arrived in the same boundary',
      [
        'The user sent this new instruction while the current task was running.',
        'Treat it as the newest user request and apply it now before continuing earlier work.',
        'If it replaces, redirects, limits, or stops prior work, follow it immediately.',
        '',
        'focus only on the failing test',
      ].join('\n'),
    ]);
  });

  it('does not interpret the content of a mid-turn instruction', () => {
    const queued = 'The user sent a new message while you were working:\n'
      + 'actually stop i dont care anymore\n\n'
      + 'This is how Claude Code surfaces messages the user sends mid-turn — within the running '
      + 'turn, often alongside the next tool result, rather than as a separate conversation turn. '
      + 'Address the message above as you continue this turn.';
    const params = translateRequest({
      model: 'sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: queued }] }],
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect((params.messages[0] as any).content[0].text).toEndWith(
      '\n\nactually stop i dont care anymore',
    );
  });

  it('preserves wrapper-like text unless the full Claude envelope matches', () => {
    const text = 'The user sent a new message while you were working:\nkeep going';
    const params = translateRequest({
      model: 'sol',
      messages: [{ role: 'user', content: text }],
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect((params.messages[0] as any).content[0].text).toBe(text);
  });

  it('preserves the Claude mid-turn wrapper for non-OAuth routes', () => {
    const queued = 'The user sent a new message while you were working:\nkeep going';
    const out = translateMessages([
      { role: 'user', content: queued },
    ], '@ai-sdk/openai') as any[];
    expect(out[0].content[0].text).toBe(queued);
  });

  it('maps tool_use → tool-call and tool_result → tool message', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }] },
    ];
    annotateToolNames(messages);
    const out = translateMessages(messages, '@ai-sdk/xai') as any[];
    expect(out[0]).toEqual({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { path: 'a' } }] });
    expect(out[1]).toEqual({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'Read', output: { type: 'text', value: 'file body' } }] });
  });

  it('lifts tool_result images into a following user message instead of inlining base64', () => {
    const data = Buffer.from('fake-png-bytes').toString('base64');
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'shot.png' } }] },
      { role: 'user' as const, content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [
          { type: 'text', text: 'rendered 1 page' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        ] },
        { type: 'text', text: 'continue' },
      ] },
    ];
    annotateToolNames(messages);
    const out = translateMessages(messages, '@ai-sdk/openai') as any[];

    expect(out[1].role).toBe('tool');
    const value = out[1].content[0].output.value as string;
    expect(value).not.toContain(data);
    expect(value).toContain('rendered 1 page');
    expect(value).toContain('attached');

    expect(out[2].role).toBe('user');
    expect(out[2].content[0]).toEqual({ type: 'text', text: expect.stringContaining('call_1') });
    expect(out[2].content[1]).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data', data: Buffer.from(data, 'base64') },
    });
    expect(out[2].content[2]).toEqual({ type: 'text', text: 'continue' });
  });

  it('decodes thought_signature into providerOptions for Google only', () => {
    const msg = [{ role: 'assistant' as const, content: [
      { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
      { type: 'tool_use', id: 'call_1__ts__VFNJRw', name: 'Read', input: {} },
    ] }];
    const google = translateMessages(msg, '@ai-sdk/google') as any[];
    expect(google[0].content[0].providerOptions).toEqual({ google: { thoughtSignature: 'SIG' } });
    expect(google[0].content[1].providerOptions).toEqual({ google: { thoughtSignature: 'TSIG' } });
    // xAI: thinking is kept as a reasoning part; tool id suffix stripped
    const xai = translateMessages(msg, '@ai-sdk/xai') as any[];
    expect(xai[0].content).toHaveLength(2);
    expect(xai[0].content[0]).toEqual({ type: 'reasoning', text: 'hmm' });
    expect(xai[0].content[1]).toEqual({ type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: {} });
  });

  it('round-trips OpenAI reasoningEncryptedContent via thinking.signature', () => {
    const msg = [{ role: 'assistant' as const, content: [
      { type: 'thinking', thinking: 'chain...', signature: 'enc_blob_abc' },
    ] }];
    const openai = translateMessages(msg, '@ai-sdk/openai') as any[];
    expect(openai[0].content[0]).toEqual({
      type: 'reasoning',
      text: 'chain...',
      providerOptions: { openai: { reasoningEncryptedContent: 'enc_blob_abc' } },
    });
  });

  it('drops empty OpenAI thinking blocks without encrypted content', () => {
    const msg = [{ role: 'assistant' as const, content: [
      { type: 'thinking', thinking: '', signature: '' },
      { type: 'text', text: 'hello' },
    ] }];
    const openai = translateMessages(msg, '@ai-sdk/openai') as any[];
    expect(openai[0].content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('maps base64 image blocks to AI SDK 7 file parts', () => {
    const out = translateMessages([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] },
    ], '@ai-sdk/google') as any[];
    expect(out[0].content[0].type).toBe('file');
    expect(out[0].content[0].mediaType).toBe('image/png');
    expect(out[0].content[0].data.type).toBe('data');
    expect(Buffer.isBuffer(out[0].content[0].data.data)).toBe(true);
  });
});

describe('translateRequest', () => {
  it('assembles SDK params and adds Google thinking options', () => {
    const params = translateRequest({
      model: 'gemini-3-flash-preview',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 256,
      temperature: 0.5,
    }, '@ai-sdk/google');
    expect(params.instructions).toBe('be brief');
    expect(params.maxOutputTokens).toBe(256);
    expect(params.temperature).toBe(0.5);
    expect(params.providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true } } });
  });

  it('requests OpenAI encrypted reasoning for Responses API round-trip', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai');
    expect(params.providerOptions?.openai).toMatchObject({
      store: false, include: ['reasoning.encrypted_content'],
    });
  });

  it('sends instructions via providerOptions and omits system/max_tokens for OpenAI OAuth', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32000,
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect(params.instructions).toBeUndefined();
    expect(params.providerOptions?.openai?.instructions).toStartWith('You are a coding assistant.');
    expect(params.providerOptions?.openai?.instructions).toContain(
      'The user may send a new message while you are still working.',
    );
    expect(params.maxOutputTokens).toBeUndefined();
  });

  it('strips Claude Code Anthropic billing attribution from OpenAI OAuth instructions only', () => {
    const body = {
      model: 'gpt-5.6-terra',
      system: [
        {
          text: 'x-anthropic-billing-header: cc_version=2.1.207.9bb; cc_entrypoint=cli; cch=24e85;',
        },
        { text: 'You are Claude Code.\nFollow the user instructions.' },
      ],
      messages: [{ role: 'user' as const, content: 'hello' }],
    };

    const oauth = translateRequest(body, '@ai-sdk/openai', { openAiOAuth: true });
    expect(oauth.providerOptions?.openai?.instructions)
      .toStartWith('You are Claude Code.\nFollow the user instructions.\n');
    expect(oauth.providerOptions?.openai?.instructions)
      .toContain('The user may send a new message while you are still working.');

    const changedAttribution = translateRequest({
      ...body,
      system: [
        { text: 'x-anthropic-billing-header: cc_version=2.1.207.9bb; cc_entrypoint=cli; cch=cb57d;' },
        body.system[1]!,
      ],
    }, '@ai-sdk/openai', { openAiOAuth: true });
    expect(changedAttribution.providerOptions?.openai?.instructions)
      .toBe(oauth.providerOptions?.openai?.instructions);
    expect(changedAttribution.providerOptions?.openai?.promptCacheKey)
      .toBe(oauth.providerOptions?.openai?.promptCacheKey);

    const publicApi = translateRequest({ ...body, model: 'gpt-5.5' }, '@ai-sdk/openai');
    expect(publicApi.instructions).toContain('x-anthropic-billing-header:');
  });

  it('maps output_config.effort to Google thinking budget without dropping includeThoughts', () => {
    const params = translateRequest({
      model: 'gemini-2.5-pro',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/google');
    expect(params.providerOptions?.google?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
  });

  it('maps GPT-5.5 output_config.effort without dropping OpenAI store/include', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai');
    expect(params.providerOptions?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
  });

  it('preserves configured and default OpenAI reasoning effort for normal requests', () => {
    const configured = translateRequest({
      model: 'gpt-5.6-sol',
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai', { defaultEffort: 'high' });
    const fallback = translateRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai', { defaultEffort: 'medium' });

    expect(configured.providerOptions?.openai?.reasoningEffort).toBe('medium');
    expect(fallback.providerOptions?.openai?.reasoningEffort).toBe('medium');
  });

  it('preserves GPT-5.6 xhigh effort without dropping OpenAI store/include', () => {
    const params = translateRequest({
      model: 'gpt-5.6-sol',
      output_config: { effort: 'xhigh' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai');
    expect(params.providerOptions?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'xhigh',
    });
  });

  it('maps output_config.effort to OpenRouter reasoning when provider metadata allows it', () => {
    const params = translateRequest({
      model: 'z-ai/glm-5.2',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@openrouter/ai-sdk-provider', {
      reasoningMetadata: {
        providerId: 'openrouter',
        supportedParameters: ['reasoning'],
      },
    });
    expect(params.providerOptions?.openrouter).toEqual({
      reasoning: {
        effort: 'high',
        exclude: false,
      },
    });
  });

  it('uses defaultEffort when the client omits output_config.effort', () => {
    const params = translateRequest({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/google', { defaultEffort: 'medium' });
    expect(params.providerOptions?.google?.thinkingConfig).toMatchObject({
      thinkingBudget: 4096,
    });
  });

  it('applies reasoning effort using reasoningMetadata.upstreamModelId, not the gateway-aliased body.model', () => {
    const params = translateRequest({
      model: 'anthropic-xai-oauth__grok-4.6',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/xai', { reasoningMetadata: { upstreamModelId: 'grok-4.6' } });
    expect(params.providerOptions?.xai).toMatchObject({ reasoningEffort: 'high' });
  });

  it('does not apply reasoning effort when only the gateway-aliased model id is available (regression guard)', () => {
    const params = translateRequest({
      model: 'anthropic-xai-oauth__grok-4.6',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/xai');
    expect(params.providerOptions?.xai).toEqual({ store: false });
  });

  it('reads effort from output_config via anthropicEffortFromRequest', () => {
    expect(anthropicEffortFromRequest({ model: 'm', messages: [], output_config: { effort: 'high' } })).toBe('high');
    expect(anthropicEffortFromRequest({ model: 'm', messages: [] })).toBeUndefined();
  });

  it('maps output_config.effort to DeepSeek reasoning_effort via openai-compatible', () => {
    const params = translateRequest({
      model: 'deepseek-v4-flash',
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai-compatible');
    expect(params.providerOptions?.openaiCompatible).toMatchObject({ reasoningEffort: 'max' });
    expect(params.providerOptions?.deepseek).toMatchObject({ thinking: { type: 'enabled' } });
  });
  it('flattens array system prompts', () => {
    const params = translateRequest({
      model: 'grok-4.6', system: [{ text: 'a' }, { text: 'b' }], messages: [],
    }, '@ai-sdk/xai');
    expect(params.instructions).toBe('a\nb');
  });

  it('preserves inline role:system messages in their original position', () => {
    const params = translateRequest({
      model: 'grok-4.6',
      system: 'base prompt',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: '<system-reminder>available skills: nlm-skill</system-reminder>' } as any,
        { role: 'user', content: 'continue' },
      ],
    }, '@ai-sdk/xai');
    expect(params.instructions).toBe('base prompt');
    expect(params.allowSystemInMessages).toBe(true);
    expect((params.messages as any[]).map(message => message.role)).toEqual(['user', 'system', 'user']);
    expect((params.messages[1] as any).content).toContain('nlm-skill');
  });

  it('keeps an inline-only system message in the message sequence', () => {
    const params = translateRequest({
      model: 'grok-4.6',
      messages: [{ role: 'system', content: 'only inline context' } as any],
    }, '@ai-sdk/xai');
    expect(params.instructions).toBeUndefined();
    expect(params.allowSystemInMessages).toBe(true);
    expect(params.messages).toEqual([{ role: 'system', content: 'only inline context' }]);
  });

  it('moves transient inline system reminders into current OAuth instructions', () => {
    const params = translateRequest({
      model: 'gpt-5.6-sol',
      system: 'stable Claude instructions',
      messages: [
        { role: 'user', content: 'continue the task' },
        {
          role: 'system',
          content: [
            { type: 'text', text: '<system-reminder>computer-use is pending</system-reminder>' },
            { type: 'text', text: '<system-reminder>playwright is pending</system-reminder>' },
          ],
        } as any,
      ],
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect((params.providerOptions as any).openai.instructions).toBe(
      'stable Claude instructions\n'
      + OPENAI_STEERING_POLICY_FOR_TESTS + '\n'
      + '<system-reminder>computer-use is pending</system-reminder>\n'
      + '<system-reminder>playwright is pending</system-reminder>',
    );
    expect(params.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'continue the task' }] }]);
  });

  it('maps Claude cache_control blocks to GPT-5.6 explicit cache breakpoints', () => {
    const params = translateRequest({
      model: 'gpt-5.6',
      system: [{ text: 'stable base', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'before' },
        {
          role: 'system',
          content: [{
            type: 'text',
            text: 'stable injected context',
            cache_control: { type: 'ephemeral' },
          }],
        } as any,
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'stable history',
            cache_control: { type: 'ephemeral' },
          }],
        },
      ],
    }, '@ai-sdk/openai');

    expect(params.instructions).toBeUndefined();
    expect((params.messages as any[]).map(message => message.role)).toEqual(['system', 'user', 'system', 'user']);
    expect((params.messages[0] as any).providerOptions).toEqual({
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    });
    expect((params.messages[2] as any).providerOptions).toEqual({
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    });
    expect((params.messages[3] as any).content[0].providerOptions).toEqual({
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    });
    expect(params.providerOptions?.openai?.promptCacheOptions).toEqual({ mode: 'implicit', ttl: '30m' });
  });

  it('does not emit unsupported explicit cache options before GPT-5.6', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }],
      }],
    }, '@ai-sdk/openai');

    expect(params.providerOptions?.openai?.promptCacheOptions).toBeUndefined();
    expect((params.messages[0] as any).content[0].providerOptions).toBeUndefined();
  });

  it('omits defer_loading tools until referenced in messages', () => {
    const params = translateRequest({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'Read', input_schema: { type: 'object' } },
        { name: 'McpTool', input_schema: { type: 'object' }, defer_loading: true },
      ],
    }, '@ai-sdk/xai');
    expect(params.tools && Object.keys(params.tools)).toEqual(['Read']);
  });

  it('preserves OpenAI reasoning partition and disables tools for compact requests', () => {
    const compactInstruction = [
      'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
      'Your task is to create a detailed summary of the conversation so far.',
      'REMINDER: Do NOT call any tools. Respond with plain text only.',
    ].join('\n');
    const tools = [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'StructuredOutput', input_schema: { type: 'object' } },
    ];
    const compactBody = {
      model: 'gpt-5.6-sol',
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file body' },
          { type: 'text', text: compactInstruction },
        ],
      }],
      tools,
      tool_choice: { type: 'any' as const },
      output_config: { effort: 'high' },
    };

    const compact = translateRequest(compactBody, '@ai-sdk/openai', { openAiOAuth: true });
    const genericCompactBody = {
      ...compactBody,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      output_config: undefined,
    };
    const genericCompact = translateRequest(
      genericCompactBody,
      '@ai-sdk/openai',
      { openAiOAuth: true, defaultEffort: 'medium' },
    );
    expect(isClaudeCodeCompactRequest(compactBody)).toBe(true);
    expect(isClaudeCodeStructuredOutputCompactRequest(compactBody)).toBe(true);
    expect(isClaudeCodeCompactRequest(genericCompactBody)).toBe(true);
    expect(isClaudeCodeStructuredOutputCompactRequest(genericCompactBody)).toBe(false);
    expect(compact.tools && Object.keys(compact.tools)).toEqual(['Read', 'StructuredOutput']);
    expect(compact.toolChoice).toBe('none');
    expect(compact.providerOptions?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
    expect(genericCompact.tools && Object.keys(genericCompact.tools)).toEqual(['Read']);
    expect(genericCompact.toolChoice).toBe('none');
    expect(genericCompact.providerOptions?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'medium',
    });
    expect(compact.messages.map(message => message.role)).toEqual(['tool', 'user']);
    expect(compact.messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: compactInstruction }],
    });
    expect(tools).toEqual([
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'StructuredOutput', input_schema: { type: 'object' } },
    ]);

    const partialMarker = translateRequest({
      ...compactBody,
      messages: [{
        role: 'user',
        content: compactInstruction.replace(/\nREMINDER:.*$/, ''),
      }],
    }, '@ai-sdk/openai', { openAiOAuth: true });
    expect(isClaudeCodeCompactRequest({
      ...compactBody,
      messages: [{
        role: 'user',
        content: compactInstruction.replace(/\nREMINDER:.*$/, ''),
      }],
    })).toBe(false);
    expect(partialMarker.tools && Object.keys(partialMarker.tools)).toEqual(['Read', 'StructuredOutput']);
    expect(partialMarker.toolChoice).toBe('required');

    const ordinary = translateRequest({
      ...compactBody,
      diagnostics: { previous_message_id: null },
    }, '@ai-sdk/openai', { openAiOAuth: true });
    expect(isClaudeCodeCompactRequest({
      ...compactBody,
      diagnostics: { previous_message_id: null },
    })).toBe(false);
    expect(ordinary.tools && Object.keys(ordinary.tools)).toEqual(['Read', 'StructuredOutput']);
    expect(ordinary.toolChoice).toBe('required');
    expect(ordinary.providerOptions?.openai?.reasoningEffort).toBe('high');
    expect(compact.providerOptions?.openai?.promptCacheKey)
      .toBe(ordinary.providerOptions?.openai?.promptCacheKey);
  });
});

describe('generateAnthropicResponse', () => {
  it('encodes non-streaming tool-call provider signatures for Gemini round-trip', async () => {
    const generateText = vi.fn(async () => ({
      text: '',
      toolCalls: [{
        toolCallId: 'call_1',
        toolName: 'Read',
        input: { path: 'a' },
        providerMetadata: { google: { thoughtSignature: 'SIG' } },
      }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));

    const body = await generateAnthropicResponse(
      {} as never,
      { messages: [] },
      'gemini-2.5-pro',
      { generateText: generateText as never },
    );
    const toolUse = (body.content as any[]).find(item => item.type === 'tool_use');
    expect(toolUse.id).toBe('call_1__ts__U0lH');
    expect(generateText.mock.calls[0]![0]).not.toHaveProperty('timeout');
    expect(generateText.mock.calls[0]![0].abortSignal.aborted).toBe(true);

  });

  it('forceStream collects a real stream into one response instead of calling generateText', async () => {
    const generateText = vi.fn();
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'text-delta', text: 'hello' };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 4 } };
    }
    const result: Record<string, unknown> = { stream: stream() };
    for (const property of ['text', 'toolCalls', 'toolResults', 'finishReason', 'usage']) {
      Object.defineProperty(result, property, {
        get() { throw new Error(`unexpected ${property} getter access`); },
      });
    }
    const streamText = vi.fn(() => result);

    const abort = new AbortController();
    const abortSignalAny = vi.spyOn(AbortSignal, 'any');
    const onPart = vi.fn();
    const body = await generateAnthropicResponse(
      {} as never,
      { messages: [] },
      'gpt-5.6-sol',
      {
        forceStream: true,
        abortSignal: abort.signal,
        onPart,
        streamText: streamText as never,
      },
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledOnce();
    expect(streamText.mock.calls[0]![0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(streamText.mock.calls[0]![0]).not.toHaveProperty('timeout');
    expect(abortSignalAny).not.toHaveBeenCalled();
    expect(streamText.mock.calls[0]![0].abortSignal.aborted).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    expect(onPart.mock.calls).toEqual([['start'], ['text-delta'], ['finish']]);
    expect((body.content as any[])[0]).toEqual({ type: 'text', text: 'hello' });
    expect(body.usage).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    abortSignalAny.mockRestore();
  });

  it('forceStream propagates an SDK error part with its upstream status', async () => {
    const upstreamError = { statusCode: 401, message: 'Unauthorized' };
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'error', error: upstreamError };
    }
    const streamText = vi.fn(() => ({ stream: stream() }));

    await expect(generateAnthropicResponse(
      {} as never,
      { messages: [] },
      'gpt-5.6-sol',
      { forceStream: true, streamText: streamText as never },
    )).rejects.toBe(upstreamError);
  });

  it('forceStream propagates an SDK abort even when lifecycle observation is disabled', async () => {
    const abort = new AbortController();
    const reason = new Error('Client disconnected');
    async function* stream() {
      yield { type: 'start' };
      abort.abort(reason);
      yield { type: 'abort' };
    }
    const streamText = vi.fn(() => ({
      text: Promise.resolve(''),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      stream: stream(),
    }));

    await expect(generateAnthropicResponse(
      {} as never,
      { messages: [] },
      'gpt-5.6-sol',
      {
        forceStream: true,
        abortSignal: abort.signal,
        streamText: streamText as never,
      },
    )).rejects.toBe(reason);
  });
});

describe('streamAnthropicResponse idle timeout', () => {
  it('consumes only the stream without touching lazy aggregate getters', async () => {
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'finish', finishReason: 'stop' };
    }
    const result: Record<string, unknown> = { stream: stream() };
    for (const property of ['text', 'toolCalls', 'toolResults', 'finishReason', 'usage']) {
      Object.defineProperty(result, property, {
        get() { throw new Error(`unexpected ${property} getter access`); },
      });
    }
    const streamText = vi.fn(() => result);

    await streamAnthropicResponse(
      {} as never,
      { messages: [] },
      'test-model',
      () => {},
      undefined,
      undefined,
      { streamText: streamText as never },
    );
    expect(streamText).toHaveBeenCalledOnce();
    expect(streamText.mock.calls[0]![0]).not.toHaveProperty('timeout');
    expect(streamText.mock.calls[0]![0].abortSignal.aborted).toBe(true);

  });

  it('aborts an upstream that never produces its first stream event', async () => {
    const hangingModel = {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'test-model',
      supportedUrls: {},
      async doStream(options: { abortSignal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => {
            reject(options.abortSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
          });
        });
      },
      async doGenerate(): Promise<never> {
        throw new Error('not used');
      },
    };

    await expect(streamAnthropicResponse(
      hangingModel as never,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never },
      'test-model',
      () => {},
      undefined,
      { idleTimeoutMs: 50 },
    )).rejects.toThrow('no data received from provider');
  }, 10_000);
});

describe('streamAnthropicResponse Grok output-loop recovery', () => {
  it('replaces one repetitive generation and keeps one Anthropic turn open', async () => {
    const repeated = ' extra';
    const signals: AbortSignal[] = [];
    const detected = vi.fn();
    let call = 0;
    const streamText = vi.fn((options: { abortSignal: AbortSignal; messages: unknown[] }) => {
      signals.push(options.abortSignal);
      call += 1;
      async function* stream() {
        yield { type: 'start' };
        if (call === 1) {
          yield { type: 'text-start', id: 'first' };
          yield {
            type: 'text-delta',
            id: 'first',
            text: "I'll apply the remaining one-line TypeScript change",
          };
          yield { type: 'text-delta', id: 'first', text: repeated.repeat(4_100) };
          yield { type: 'finish', finishReason: 'length' };
          return;
        }
        yield { type: 'reasoning-start', id: 'recovery-reasoning' };
        yield { type: 'reasoning-delta', id: 'recovery-reasoning', text: 'Choose another path.' };
        yield {
          type: 'reasoning-end',
          id: 'recovery-reasoning',
          providerMetadata: { openai: { reasoningEncryptedContent: 'sig' } },
        };
        yield { type: 'text-start', id: 'recovered' };
        yield { type: 'text-delta', id: 'recovered', text: 'I will inspect the completed results now.' };
        yield { type: 'text-end', id: 'recovered' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 11, outputTokens: 9 },
        };
      }
      return { stream: stream() };
    });
    let raw = '';

    await streamAnthropicResponse(
      {} as never,
      { messages: [{ role: 'user', content: 'Finish the lint task.' }] },
      'grok',
      chunk => { raw += chunk; },
      undefined,
      {
        recoverOutputLoops: true,
        outputLoopRecoveryNonce: () => '123e4567-e89b-12d3-a456-426614174000',
        onOutputLoopDetected: detected,
      },
      { streamText: streamText as never },
    );

    expect(streamText).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    const recoveryMessages = streamText.mock.calls[1]?.[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(recoveryMessages.at(-2)?.role).toBe('assistant');
    expect(recoveryMessages.at(-2)?.content)
      .toBe("I'll apply the remaining one-line TypeScript change");
    expect(recoveryMessages.at(-1)?.content)
      .toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(detected).toHaveBeenCalledOnce();
    expect(detected.mock.calls[0]?.[0]).toMatchObject({ recoveryAttempt: 0 });
    expect(raw.match(/event: message_start/g)).toHaveLength(1);
    expect(raw.match(/event: message_stop/g)).toHaveLength(1);
    expect(raw).not.toContain(repeated.repeat(8));
    expect(raw).not.toContain('thinking_delta');
    expect(raw).toContain('I will inspect the completed results now.');
    expect(raw).toContain('"stop_reason":"end_turn"');
  });

  it('stops cleanly when the one recovery attempt also loops', async () => {
    const repeated = 'The same response is still repeating verbatim. ';
    const detected = vi.fn();
    const streamText = vi.fn(() => {
      async function* stream() {
        yield { type: 'start' };
        yield { type: 'text-start', id: 'text' };
        yield { type: 'text-delta', id: 'text', text: repeated.repeat(80) };
      }
      return { stream: stream() };
    });
    let raw = '';

    await streamAnthropicResponse(
      {} as never,
      { messages: [{ role: 'user', content: 'Continue.' }] },
      'grok',
      chunk => { raw += chunk; },
      undefined,
      { recoverOutputLoops: true, onOutputLoopDetected: detected },
      { streamText: streamText as never },
    );

    expect(streamText).toHaveBeenCalledTimes(2);
    expect(detected).toHaveBeenCalledTimes(2);
    expect(raw).toContain('Clodex stopped repetitive Grok output');
    expect(raw.match(/event: message_stop/g)).toHaveLength(1);
  });

  it('can continue the recovered turn with a tool call', async () => {
    const repeated = 'I will keep waiting for the same unchanged result. ';
    let call = 0;
    const streamText = vi.fn(() => {
      call += 1;
      async function* stream() {
        yield { type: 'start' };
        if (call === 1) {
          yield { type: 'text-start', id: 'loop' };
          yield { type: 'text-delta', id: 'loop', text: repeated.repeat(80) };
          return;
        }
        yield {
          type: 'tool-call',
          toolCallId: 'call_recovered',
          toolName: 'ListAgents',
          input: {},
        };
        yield { type: 'finish', finishReason: 'tool-calls' };
      }
      return { stream: stream() };
    });
    let raw = '';

    await streamAnthropicResponse(
      {} as never,
      { messages: [{ role: 'user', content: 'Continue.' }] },
      'grok',
      chunk => { raw += chunk; },
      undefined,
      { recoverOutputLoops: true },
      { streamText: streamText as never },
    );

    expect(streamText).toHaveBeenCalledTimes(2);
    expect(raw).toContain('"type":"tool_use"');
    expect(raw).toContain('"name":"ListAgents"');
    expect(raw).toContain('"stop_reason":"tool_use"');
    expect(raw.match(/event: message_stop/g)).toHaveLength(1);
  });

  it('does not replay a response after it has emitted a tool call', async () => {
    const repeated = 'This post-tool text is repeating without progress. ';
    const streamText = vi.fn(() => {
      async function* stream() {
        yield { type: 'start' };
        yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { path: 'a' } };
        yield { type: 'text-start', id: 'text' };
        yield { type: 'text-delta', id: 'text', text: repeated.repeat(80) };
      }
      return { stream: stream() };
    });
    let raw = '';

    await streamAnthropicResponse(
      {} as never,
      { messages: [{ role: 'user', content: 'Continue.' }] },
      'grok',
      chunk => { raw += chunk; },
      undefined,
      { recoverOutputLoops: true },
      { streamText: streamText as never },
    );

    expect(streamText).toHaveBeenCalledOnce();
    expect(raw).toContain('Clodex stopped repetitive Grok output');
    expect(raw).toContain('"type":"tool_use"');
    expect(raw.match(/event: message_stop/g)).toHaveLength(1);
  });
});

// ── streaming translation ────────────────────────────────────────────────────
async function collect(
  parts: any[],
  model = 'm',
  observer?: Parameters<typeof writeAnthropicStream>[4],
  tools?: Parameters<typeof writeAnthropicStream>[5],
): Promise<{ events: Array<{ event: string; data: any }>; raw: string }> {
  let raw = '';
  async function* gen() { for (const p of parts) yield p; }
  await writeAnthropicStream(gen() as any, model, (c) => { raw += c; }, undefined, observer, tools);
  const events = raw.split('\n\n').filter(Boolean).map(block => {
    const [evLine, dataLine] = block.split('\n');
    return { event: evLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) };
  });
  return { events, raw };
}

describe('writeAnthropicStream', () => {
  it('emits a well-formed text turn', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Hello' },
      { type: 'text-delta', id: 't1', text: ' world' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 2 } },
    ], 'm', { initialInputTokens: 37 });
    const types = events.map(e => e.event);
    expect(types).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    const start = events.find(e => e.event === 'message_start')!;
    expect(start.data.message.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const delta = events.find(e => e.event === 'message_delta')!;
    expect(delta.data.delta.stop_reason).toBe('end_turn');
    expect(delta.data.usage).toEqual({
      input_tokens: 5,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('maps OpenAI native web search to Anthropic server-tool blocks', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'tool-input-start',
        id: 'ws_123',
        toolName: 'web_search',
        providerExecuted: true,
      },
      { type: 'tool-input-end', id: 'ws_123' },
      {
        type: 'tool-call',
        toolCallId: 'ws_123',
        toolName: 'web_search',
        input: {},
        providerExecuted: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'ws_123',
        toolName: 'web_search',
        input: {},
        output: {
          action: { type: 'search', query: 'latest OpenAI news' },
          sources: [
            { type: 'url', url: 'https://openai.com/news/' },
            { type: 'api', name: 'ignored-api-source' },
          ],
        },
        providerExecuted: true,
      },
      { type: 'text-start', id: 'text_1' },
      { type: 'text-delta', id: 'text_1', text: 'OpenAI published an update.' },
      { type: 'text-end', id: 'text_1' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    const starts = events
      .filter(event => event.event === 'content_block_start')
      .map(event => event.data.content_block);
    expect(starts).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_ws_123',
        name: 'web_search',
        input: {},
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_ws_123',
        content: [{
          type: 'web_search_result',
          url: 'https://openai.com/news/',
          title: 'https://openai.com/news/',
          encrypted_content: '',
          page_age: null,
        }],
      },
      { type: 'text', text: '' },
    ]);
    expect(events.find(event =>
      event.event === 'content_block_delta'
      && event.data.delta.type === 'input_json_delta'
    )?.data.delta.partial_json).toBe('{"query":"latest OpenAI news"}');
    expect(events.find(event => event.event === 'message_delta')?.data.delta.stop_reason)
      .toBe('end_turn');
  });

  it('does not double-count the local estimate when final input is fully cached', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 173_000,
          outputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 173_000 },
        },
      },
    ], 'm', { initialInputTokens: 61_500 });

    const start = events.find(e => e.event === 'message_start')!.data.message.usage;
    const delta = events.find(e => e.event === 'message_delta')!.data.usage;
    const claudeMergedUsage = {
      input_tokens: delta.input_tokens > 0 ? delta.input_tokens : start.input_tokens,
      cache_creation_input_tokens: delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : start.cache_creation_input_tokens,
      cache_read_input_tokens: delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : start.cache_read_input_tokens,
    };

    expect(
      claudeMergedUsage.input_tokens
      + claudeMergedUsage.cache_creation_input_tokens
      + claudeMergedUsage.cache_read_input_tokens,
    ).toBe(173_000);
  });

  it('uses the local input estimate when final usage omits input tokens', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 7 },
      },
    ], 'm', { initialInputTokens: 37 });

    expect(events.find(e => e.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 37,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('reports cache hits: inputTokenDetails.cacheReadTokens → cache_read_input_tokens', async () => {
    // OpenAI reports cached tokens WITHIN the prompt total (inputTokens=100 incl.
    // 80 cache hits). Anthropic's input_tokens must be the uncached remainder (20)
    // with the 80 surfaced as cache_read_input_tokens.
    const { events } = await collect([
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'hi' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 100, outputTokens: 7, inputTokenDetails: { cacheReadTokens: 80 } },
      },
    ]);
    expect(events.find(e => e.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    });
  });

  it('reports GPT-5.6 cache writes as Anthropic cache creation tokens', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 120,
          outputTokens: 3,
          inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 80 },
        },
      },
    ]);
    expect(events.find(e => e.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 3,
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 20,
    });
  });

  it('propagates an AI SDK stream failure so the HTTP layer can preserve its status', async () => {
    const upstreamError = { statusCode: 401, message: 'Unauthorized' };
    async function* parts() {
      yield { type: 'error', error: upstreamError };
    }

    await expect(writeAnthropicStream(parts() as any, 'm', () => {})).rejects.toBe(upstreamError);
  });

  it('reports every SDK stream part to the lifecycle observer', async () => {
    const observed: string[] = [];
    async function* parts() {
      yield { type: 'start' };
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', text: 'hi' };
      yield { type: 'finish', finishReason: 'stop' };
    }

    await writeAnthropicStream(
      parts() as any,
      'm',
      () => {},
      undefined,
      { onPart: type => observed.push(type) },
    );

    expect(observed).toEqual(['start', 'text-start', 'text-delta', 'finish']);
  });

  it('propagates an SDK abort without synthesizing a completed response', async () => {
    const abort = new AbortController();
    const reason = new Error('Client disconnected');
    const observed: string[] = [];
    const writes: string[] = [];
    async function* parts() {
      yield { type: 'start' };
      abort.abort(reason);
      yield { type: 'abort', reason: 'abort' };
    }

    await expect(writeAnthropicStream(
      parts() as any,
      'm',
      chunk => writes.push(chunk),
      undefined,
      { abortSignal: abort.signal, onPart: type => observed.push(type) },
    )).rejects.toBe(reason);

    expect(observed).toEqual(['start', 'abort']);
    expect(writes).toEqual([]);
  });

  it('wraps a string stream failure for the HTTP layer', async () => {
    async function* parts() {
      yield { type: 'error', error: 'Something went wrong' };
    }

    await expect(writeAnthropicStream(parts() as any, 'm', () => {})).rejects.toThrow('Something went wrong');
  });

  it('encodes thought_signature into the tool_use id and reports tool_use stop', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_9', toolName: 'Read', providerMetadata: { google: { thoughtSignature: 'SIG9' } } },
      { type: 'tool-input-delta', id: 'call_9', delta: '{"path":"x"}' },
      { type: 'tool-input-end', id: 'call_9' },
      { type: 'tool-call', toolCallId: 'call_9', toolName: 'Read', input: { path: 'x' } },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    const start = events.find(e => e.event === 'content_block_start')!;
    expect(start.data.content_block.type).toBe('tool_use');
    expect(start.data.content_block.id).toBe('call_9__ts__U0lHOQ');
    expect(events.find(e => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  // GPT-family models fill optional tool params with filler (`null`, `[]`)
  // instead of omitting them; Claude Code forwards e.g. WebSearch domain lists
  // verbatim into the server-side web_search config, where an empty list is a
  // 400. The adapter must strip that filler from the tool_use blocks it emits.
  const webSearchTools = translateTools([{
    name: 'WebSearch',
    description: 'Search the web',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        allowed_domains: { type: 'array', items: { type: 'string' } },
        blocked_domains: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  }]);

  function toolInputFromEvents(events: Array<{ event: string; data: any }>): any {
    const start = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')!;
    const json = events
      .filter(e => e.event === 'content_block_delta' && e.data.index === start.data.index && e.data.delta.type === 'input_json_delta')
      .map(e => e.data.delta.partial_json)
      .join('');
    return JSON.parse(json || '{}');
  }

  it('strips null and empty-array filler for optional params from streamed tool input', async () => {
    const input = { query: 'who won', allowed_domains: ['fifa.com'], blocked_domains: [], max_uses: null };
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'WebSearch' },
      { type: 'tool-input-delta', id: 'call_1', delta: JSON.stringify(input).slice(0, 20) },
      { type: 'tool-input-delta', id: 'call_1', delta: JSON.stringify(input).slice(20) },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'WebSearch', input },
      { type: 'finish', finishReason: 'tool-calls' },
    ], 'm', undefined, webSearchTools);
    expect(toolInputFromEvents(events)).toEqual({ query: 'who won', allowed_domains: ['fifa.com'] });
  });

  it('strips the same filler from a non-streamed tool call', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'WebSearch', input: { query: 'who won', blocked_domains: [], allowed_domains: null } },
      { type: 'finish', finishReason: 'tool-calls' },
    ], 'm', undefined, webSearchTools);
    expect(toolInputFromEvents(events)).toEqual({ query: 'who won' });
  });

  it('preserves an intentional empty array for a schema-required property', async () => {
    const todoTools = translateTools([{
      name: 'TodoWrite',
      description: 'Update the todo list',
      input_schema: {
        type: 'object',
        properties: { todos: { type: 'array' } },
        required: ['todos'],
      },
    }]);
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'TodoWrite' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"todos":[]}' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'TodoWrite', input: { todos: [] } },
      { type: 'finish', finishReason: 'tool-calls' },
    ], 'm', undefined, todoTools);
    expect(toolInputFromEvents(events)).toEqual({ todos: [] });
  });

  it('emits the buffered raw tool input when the stream ends without a tool-call part', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"path":' },
      { type: 'tool-input-delta', id: 'call_1', delta: '"x"}' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(toolInputFromEvents(events)).toEqual({ path: 'x' });
    // The block must still be closed after the late flush.
    const start = events.find(e => e.event === 'content_block_start')!;
    expect(events.some(e => e.event === 'content_block_stop' && e.data.index === start.data.index)).toBe(true);
  });

  it('emits thinking block with a signature_delta close (Google SDK)', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'thinking...' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: { google: { thoughtSignature: 'RSIG' } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'done' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const thinkStart = events.find(e => e.event === 'content_block_start')!;
    expect(thinkStart.data.content_block.type).toBe('thinking');
    const sigDelta = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta')!;
    expect(sigDelta.data.delta.signature).toBe('RSIG');
  });

  it('emits thinking block with OpenAI reasoningEncryptedContent in signature_delta', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'thinking...' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: { openai: { reasoningEncryptedContent: 'enc_xyz' } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'done' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const sigDelta = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta')!;
    expect(sigDelta.data.delta.signature).toBe('enc_xyz');
  });
});

describe('translateRequest openai promptCacheKey', () => {
  const READ_TOOL = { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };
  const req = (over: Partial<Parameters<typeof translateRequest>[0]> = {}) => ({
    model: 'gpt-5.5',
    system: 'You are a coding assistant.',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [READ_TOOL],
    ...over,
  });
  const keyOf = (body: Parameters<typeof translateRequest>[0], npm = '@ai-sdk/openai', opts?: Parameters<typeof translateRequest>[2]) =>
    translateRequest(body, npm, opts).providerOptions?.openai?.promptCacheKey as string | undefined;

  it('sets a stable key for the API-key OpenAI path; identical prefix → identical key', () => {
    const a = keyOf(req());
    const b = keyOf(req());
    expect(typeof a).toBe('string');
    expect(a).toBe(b);
  });

  it('changes the key when the top-level system prompt differs (distinct sessions)', () => {
    expect(keyOf(req({ system: 'date: 2026-07-12' }))).not.toBe(keyOf(req({ system: 'date: 2026-07-13' })));
  });

  it('changes the key when the tool set differs', () => {
    const write = { ...READ_TOOL, name: 'Write' };
    expect(keyOf(req({ tools: [READ_TOOL] }))).not.toBe(keyOf(req({ tools: [READ_TOOL, write] })));
  });

  it('keeps the key stable across volatile inline system-reminders (within-session turns)', () => {
    // Inline reminders remain in message order and must not churn the stable
    // system+tools cache partition key.
    const withReminder = (t: string) => req({
      messages: [
        { role: 'system' as const, content: `<system-reminder>current time ${t}</system-reminder>` },
        { role: 'user' as const, content: 'hello' },
      ],
    });
    expect(keyOf(withReminder('10:00:01'))).toBe(keyOf(withReminder('10:05:42')));
  });

  it('sends a session-derived key but omits risky cache options on ChatGPT/Codex OAuth', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const params = translateRequest({
      ...req(),
      model: 'gpt-5.6-sol',
      metadata: { user_id: JSON.stringify({ session_id: sessionId, device_id: 'private' }) },
    }, '@ai-sdk/openai', {
      openAiOAuth: true,
      reasoningMetadata: { upstreamModelId: 'gpt-5.6-sol' },
    });
    expect(params.providerOptions?.openai?.promptCacheKey).toBe(claudeSessionPromptCacheKey(sessionId));
    expect(params.providerOptions?.openai?.promptCacheOptions).toBeUndefined();
  });

  it('uses the body session before the header and falls back safely on malformed metadata', () => {
    const bodySession = '11111111-1111-4111-8111-111111111111';
    const headerSession = '22222222-2222-4222-8222-222222222222';
    expect(extractClaudeSessionId({
      metadata: { user_id: JSON.stringify({ session_id: bodySession }) },
    }, headerSession)).toBe(bodySession);
    expect(extractClaudeSessionId({ metadata: { user_id: '{bad json' } }, headerSession)).toBe(headerSession);
    expect(extractClaudeSessionId({ metadata: { user_id: JSON.stringify({ session_id: 'not-a-uuid' }) } })).toBeUndefined();
  });

  it('keeps a Claude session key stable across system/tool changes', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const options = { openAiOAuth: true, claudeSessionId: sessionId };
    expect(keyOf(req({ system: 'first' }), '@ai-sdk/openai', options))
      .toBe(keyOf(req({ system: 'second', tools: [] }), '@ai-sdk/openai', options));
  });

  it('omits the key for non-OpenAI providers', () => {
    expect(keyOf(req(), '@ai-sdk/xai')).toBeUndefined();
  });
});
