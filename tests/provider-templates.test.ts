import { describe, it, expect, vi, afterEach } from 'bun:test';
import {
  filterTemplates,
  getTemplateById,
  listAddableTemplates,
  listSupportedTemplates,
  listVisibleOAuthTemplates,
} from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { stubTestGlobal } from './test-helpers.js';

describe('provider templates', () => {
  it('offers exactly the OpenAI API-key template as addable', () => {
    expect(listSupportedTemplates().map(t => t.id)).toEqual(['openai']);
  });

  it('filters templates by search query', () => {
    const templates = listSupportedTemplates();
    expect(filterTemplates(templates, 'open').map(t => t.id)).toEqual(['openai']);
    expect(filterTemplates(templates, 'groq')).toEqual([]);
  });

  it('looks up template by id', () => {
    expect(getTemplateById('openai')?.npm).toBe('@ai-sdk/openai');
    expect(getTemplateById('openai-oauth')?.authType).toBe('oauth');
    expect(getTemplateById('xai-oauth')).toMatchObject({
      authType: 'oauth',
      npm: '@ai-sdk/xai',
      staticModels: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
    });
    expect(getTemplateById('xai')).toBeUndefined();
    expect(getTemplateById('groq')).toBeUndefined();
  });

  it('lists the subscription OAuth templates for discovery surfaces', () => {
    expect(listVisibleOAuthTemplates().map(t => t.id)).toEqual(['openai-oauth', 'xai-oauth']);
    expect(listVisibleOAuthTemplates(['openai-oauth']).map(t => t.id)).not.toContain('openai-oauth');
  });

  it('excludes already-configured providers from addable list', () => {
    expect(listAddableTemplates(['openai']).map(t => t.id)).toEqual([]);
    expect(listAddableTemplates([]).map(t => t.id)).toEqual(['openai']);
  });
});

describe('fetchTemplateModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses OpenAI-style model list', async () => {
    stubTestGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      }),
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'test-key');
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe('gpt-5.6-sol');
    expect(result.models[0]?.modelFormat).toBe('openai');
  });

  it('returns helpful error on 401', async () => {
    stubTestGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid key',
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'bad-key');
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain('rejected');
  });
});
