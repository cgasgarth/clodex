// xai-oauth-models.ts — models available through SuperGrok subscription OAuth

import type { CachedModel } from '../registry/types.js';
import { XAI_SUBSCRIPTION_MODEL } from '../oauth/xai-proxy.js';

export function buildXaiOAuthModels(): CachedModel[] {
  return [{
    id: XAI_SUBSCRIPTION_MODEL,
    name: 'Grok 4.6',
    upstreamModelId: XAI_SUBSCRIPTION_MODEL,
    family: 'grok',
    brand: 'Grok',
    contextWindow: 500_000,
    modelFormat: 'openai',
    npm: '@ai-sdk/xai',
    reasoning: true,
  }];
}
