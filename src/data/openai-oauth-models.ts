// src/data/openai-oauth-models.ts
//
// Model metadata used to enrich the signed-in account's public /v1/models catalog.
// Live discovery determines which models are available; this list supplies
// confirmed context-window and reasoning metadata for known models.

import type { CachedModel } from '../registry/types.js';
import { resolveContextWindow } from '../models/context-window.js';
import { deriveBrand } from '../models/types.js';

interface OAuthModelSeed {
  id: string;
  name: string;
  /** ChatGPT Codex client input window, which may differ from the public API model. */
  contextWindow?: number;
  reasoning?: boolean;
}

/** Claude-facing context policy for current OpenAI million-token routes. */
export const OPENAI_MILLION_CONTEXT_WINDOW = 1_000_000;

/** Models whose live ChatGPT catalog still reports the old 272K window. */
export const OPENAI_MILLION_CONTEXT_MODELS = new Set<string>([
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-luna',
]);

/** Sol routes hidden from the OpenAI OAuth catalog. */
export const OPENAI_OAUTH_RETIRED_MODELS = new Set<string>([
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

// Known model metadata for ChatGPT plan usage.
// Ordered from newest to oldest within each tier.
const OPENAI_OAUTH_MODEL_SEEDS: OAuthModelSeed[] = [
  // GPT-6 family
  { id: 'gpt-6.1-sol',          name: 'sol-6.1',           contextWindow: OPENAI_MILLION_CONTEXT_WINDOW, reasoning: true },
  { id: 'gpt-6-astra',          name: 'GPT-6 Astra',       contextWindow: OPENAI_MILLION_CONTEXT_WINDOW, reasoning: true },
  { id: 'gpt-6-luna',           name: 'GPT-6 Luna',        contextWindow: OPENAI_MILLION_CONTEXT_WINDOW, reasoning: true },
  // GPT-5.5 family (Pro)
  { id: 'gpt-5.5',              name: 'GPT-5.5',           contextWindow: 272_000, reasoning: true },
  // GPT-5.4 family
  { id: 'gpt-5.4',              name: 'GPT-5.4',           contextWindow: 272_000 },
  { id: 'gpt-5.4-mini',         name: 'GPT-5.4 Mini',      contextWindow: 272_000 },
  // GPT-5 base (Pro / Plus)
  { id: 'gpt-5',                name: 'GPT-5',             contextWindow: 272_000, reasoning: true },
  // o-series reasoning (Plus+)
  { id: 'o4-mini',              name: 'o4 Mini',           reasoning: true },
  { id: 'o3',                   name: 'o3',                reasoning: true },
  { id: 'o3-mini',              name: 'o3 Mini',           reasoning: true },
  { id: 'o1',                   name: 'o1',                reasoning: true },
  { id: 'o1-mini',              name: 'o1 Mini',           reasoning: true },
];

export function buildOpenAiOAuthModels(): CachedModel[] {
  return OPENAI_OAUTH_MODEL_SEEDS.map(seed => {
    const prefix = seed.id.split('-')[0] ?? seed.id;
    return {
      id: seed.id,
      name: seed.name,
      upstreamModelId: seed.id,
      family: prefix,
      brand: deriveBrand(prefix),
      contextWindow: resolveContextWindow(seed.id, seed.contextWindow),
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai',
      reasoning: seed.reasoning,
    };
  });
}
