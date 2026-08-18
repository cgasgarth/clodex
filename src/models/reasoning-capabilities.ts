import {
  effortProviderOptions as providerEffortOptions,
  getReasoningCapabilities,
  type ReasoningCapabilities,
  type ReasoningMetadata,
} from '../provider-factory.js';
import type { ProviderOptions } from '@ai-sdk/provider-utils';

export type {
  ReasoningCapabilities,
  ReasoningMetadata,




} from '../provider-factory.js';

export interface ResolveReasoningInput extends ReasoningMetadata {
  npm: string;
  modelId: string;
}

export function resolveReasoningCapabilities(input: ResolveReasoningInput): ReasoningCapabilities {
  const { npm, modelId, ...metadata } = input;
  return getReasoningCapabilities(npm, modelId, metadata);
}

export function effortProviderOptions(
  npm: string,
  effort?: string,
  modelId?: string,
  metadata?: ReasoningMetadata,
): ProviderOptions | undefined {
  return providerEffortOptions(npm, effort, modelId, metadata);
}
