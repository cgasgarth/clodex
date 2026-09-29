import { afterEach, describe, expect, it, vi } from 'bun:test';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import * as io from '../src/registry/io.js';
import type { ProviderRegistry } from '../src/registry/types.js';
import { asMocked } from './test-helpers.js';

vi.mock('../src/registry/io.js', () => ({ loadRegistry: vi.fn(), loadRegistryStrict: vi.fn(), saveRegistry: vi.fn() }));
vi.mock('../src/registry/pricing.js', () => ({
  loadPricingCache: vi.fn(), enrichModelsWithPricing: vi.fn(models => models),
  enrichPricingAsync: vi.fn(), pricingPlatformForProvider: vi.fn(), buildPricingIndex: vi.fn(),
}));

const originalFetch = global.fetch;
const token = `e30.${Buffer.from(JSON.stringify({ scope: 'chatgpt.tokens.use.direct' })).toString('base64url')}.signature`;
function registry(): ProviderRegistry {
  return { schemaVersion: 1, providers: [{ id: 'openai-oauth', templateId: 'openai',
    name: 'OpenAI (ChatGPT)', enabled: true, authRef: 'keyring', authType: 'oauth', api: {},
  }] };
}
afterEach(() => { global.fetch = originalFetch; vi.clearAllMocks(); });

describe('ChatGPT plan model discovery', () => {
  it('loads the account catalog from the public API and preserves Sol context', async () => {
    const saved = registry();
    asMocked(io.loadRegistryStrict).mockReturnValue(saved);
    const request = vi.fn(async () => Response.json({ models: [
      { slug: 'gpt-6.1-sol', display_name: 'Sol 6.1', visibility: 'list', context_window: 272_000 },
    ] }));
    global.fetch = Object.assign(request, { preconnect: originalFetch.preconnect });
    const result = await refreshProviderModels('openai-oauth', token, saved);
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(request).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
    }));
    expect(asMocked(io.saveRegistry).mock.calls[0]?.[0].providers[0]?.modelsCache?.models[0]).toMatchObject({
      id: 'gpt-6.1-sol', name: 'sol-6.1', contextWindow: 1_000_000,
    });
  });

  it('reports account admission failures without overwriting the catalog', async () => {
    const saved = registry();
    asMocked(io.loadRegistryStrict).mockReturnValue(saved);
    global.fetch = Object.assign(vi.fn(async () => Response.json({ detail: 'permission denied' }, { status: 403 })), { preconnect: originalFetch.preconnect });
    const result = await refreshProviderModels('openai-oauth', token, saved);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('403');
    expect(io.saveRegistry).not.toHaveBeenCalled();
  });
});
