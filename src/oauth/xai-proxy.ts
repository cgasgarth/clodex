// xai-proxy.ts — SuperGrok subscription transport for the Grok CLI proxy

import { randomUUID } from 'node:crypto';
import { VERSION } from '../constants.js';

export const XAI_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const XAI_SUBSCRIPTION_MODEL = 'grok-4.6';

function xaiClientMode(): 'interactive' | 'headless' {
  return process.stdin.isTTY && process.stdout.isTTY ? 'interactive' : 'headless';
}

export function createXaiSubscriptionFetch(
  modelId: string,
  sessionId: string = randomUUID(),
  transport: typeof fetch = fetch,
): typeof fetch {
  if (modelId !== XAI_SUBSCRIPTION_MODEL) {
    throw new Error(`SuperGrok supports only ${XAI_SUBSCRIPTION_MODEL}`);
  }
  const conversationId = sessionId;

  return Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'https://cli-chat-proxy.grok.com' || url.pathname !== '/v1/responses') {
        throw new Error('Refusing to send a SuperGrok credential to an unexpected endpoint');
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set('User-Agent', `clodex/${VERSION}`);
      headers.set('X-XAI-Token-Auth', 'xai-grok-cli');
      headers.set('x-authenticateresponse', 'authenticate-response');
      headers.set('x-grok-client-identifier', 'clodex');
      headers.set('x-grok-client-version', VERSION);
      headers.set('x-grok-client-mode', xaiClientMode());
      headers.set('x-grok-conv-id', conversationId);
      headers.set('x-grok-req-id', randomUUID());
      headers.set('x-grok-model-override', XAI_SUBSCRIPTION_MODEL);
      headers.set('x-grok-session-id', sessionId);
      return transport(input, { ...init, headers, redirect: 'error' });
    },
    { preconnect: fetch.preconnect },
  );
}
