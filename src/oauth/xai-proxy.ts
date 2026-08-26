// xai-proxy.ts — SuperGrok subscription transport for the Grok CLI proxy

import { randomUUID } from 'node:crypto';
import { VERSION } from '../constants.js';
import { isObject, isString } from '../runtime/type-guards.js';
import type { JsonObject, JsonValue } from './responses-websocket/types.js';

export const XAI_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const XAI_SUBSCRIPTION_MODEL = 'grok-4.6';

const XAI_DOOM_LOOP_CHECK_EVENT = 'response.doom_loop_check';
const XAI_DOOM_LOOP_RECOVERY_REMINDER = '<system_reminder>Your messages have been flagged as looping. Your response has been flagged as repeating the same text pattern. Avoid excessive repetition. If you are having trouble ask the user for guidance.</system_reminder>';
const XAI_DOOM_LOOP_DEFAULT_WINDOW_TOKENS = 1_024;
const XAI_DOOM_LOOP_DEFAULT_MAX_THRESHOLD = 64;
const XAI_DOOM_LOOP_DEFAULT_MAX_RETRIES = 2;
const XAI_DOOM_LOOP_MIN_WINDOW_TOKENS = 512;
const XAI_DOOM_LOOP_MAX_WINDOW_TOKENS = 4_096;
const XAI_DOOM_LOOP_MIN_THRESHOLD = 2;
const XAI_DOOM_LOOP_MAX_THRESHOLD = 64;
const XAI_DOOM_LOOP_MAX_RETRIES = 5;

export interface XaiDoomLoopRecoverySettings {
  enabled?: boolean;
  maxThreshold?: number;
  maxRetries?: number;
  windowTokens?: number;
}

export interface XaiDoomLoopRecoveryPolicy {
  maxThreshold: number;
  maxRetries: number;
  windowTokens: number;
}

interface XaiDoomLoopRecoveryDependencies {
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  settings?: XaiDoomLoopRecoverySettings;
  env?: Record<string, string | undefined>;
}

interface ParsedSseFrame {
  eventName?: string;
  payload?: JsonObject;
}

type FrameDecision =
  | { kind: 'continue' }
  | { kind: 'retry' }
  | { kind: 'fail'; triggers: string[] };

function isJsonObject(value: JsonValue): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

function parseSseFrame(frame: string): ParsedSseFrame {
  const data: string[] = [];
  let eventName: string | undefined;
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  const joined = data.join('\n');
  let payload: JsonObject | undefined;
  try {
    const parsed: JsonValue = JSON.parse(joined);
    if (isJsonObject(parsed)) payload = parsed;
  } catch {
    // xAI treats malformed detector frames as non-fatal and swallows them.
  }
  return { eventName, payload };
}

function triggerLabels(payload?: JsonObject): string[] {
  if (!payload) return [];
  const direct = payload.doom_loop_check;
  const response = payload.response;
  const nested = isJsonObject(response)
    ? response.doom_loop_check
    : undefined;
  const check = direct ?? nested;
  if (!isJsonObject(check)) return [];
  const triggers = check.triggers;
  return Array.isArray(triggers)
    ? triggers.filter(isString)
    : [];
}

function isDoomLoopCheckFrame(frame: ParsedSseFrame): boolean {
  return frame.eventName === XAI_DOOM_LOOP_CHECK_EVENT
    || frame.payload?.type === XAI_DOOM_LOOP_CHECK_EVENT;
}

function parseEnvironmentBoolean(value: string | undefined): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return false;
    default:
      return undefined;
  }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function resolveXaiDoomLoopRecoveryPolicy(
  settings: XaiDoomLoopRecoverySettings = {},
  env: Record<string, string | undefined> = process.env,
): XaiDoomLoopRecoveryPolicy | undefined {
  const enabled = parseEnvironmentBoolean(env['GROK_DOOM_LOOP_RECOVERY'])
    ?? settings.enabled
    ?? true;
  if (!enabled) return undefined;
  const configuredWindow = settings.windowTokens;
  const windowTokens = configuredWindow === undefined
    ? XAI_DOOM_LOOP_DEFAULT_WINDOW_TOKENS
    : Number.isInteger(configuredWindow)
      && configuredWindow >= XAI_DOOM_LOOP_MIN_WINDOW_TOKENS
      && configuredWindow <= XAI_DOOM_LOOP_MAX_WINDOW_TOKENS
      ? configuredWindow
      : XAI_DOOM_LOOP_MAX_WINDOW_TOKENS;
  return {
    maxThreshold: clampInteger(
      settings.maxThreshold,
      XAI_DOOM_LOOP_DEFAULT_MAX_THRESHOLD,
      XAI_DOOM_LOOP_MIN_THRESHOLD,
      XAI_DOOM_LOOP_MAX_THRESHOLD,
    ),
    maxRetries: clampInteger(
      settings.maxRetries,
      XAI_DOOM_LOOP_DEFAULT_MAX_RETRIES,
      0,
      XAI_DOOM_LOOP_MAX_RETRIES,
    ),
    windowTokens,
  };
}

function confidentThinkingLoops(
  labels: string[],
  policy: XaiDoomLoopRecoveryPolicy | undefined,
): string[] {
  if (!policy) return [];
  return labels.filter(label => {
    const match = label.match(/^tail_repetition:(\d+)@thinking$/);
    return match !== null && Number(match[1]) <= policy.maxThreshold;
  });
}

function appendDoomLoopRecoveryReminder(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (!isString(body)) return body;
  let request: JsonObject;
  try {
    const parsed: JsonValue = JSON.parse(body);
    if (!isJsonObject(parsed)) return body;
    request = parsed;
  } catch {
    return body;
  }
  if (!Array.isArray(request.input)) return body;
  request.input.push({
    role: 'user',
    content: [{ type: 'input_text', text: XAI_DOOM_LOOP_RECOVERY_REMINDER }],
  });
  return JSON.stringify(request);
}

function commitsProviderOutput(payload?: JsonObject): boolean {
  const type = isString(payload?.type) ? payload.type : '';
  if (
    type === 'response.output_text.delta'
    || type === 'response.output_text.done'
    || type === 'response.function_call_arguments.delta'
    || type === 'response.function_call_arguments.done'
    || type === 'response.custom_tool_call_input.delta'
    || type === 'response.custom_tool_call_input.done'
  ) return true;
  if (type !== 'response.output_item.done') return false;
  const item = payload?.item;
  if (!isJsonObject(item)) return false;
  const itemType = item.type;
  return itemType !== 'reasoning' && itemType !== 'message';
}

function nextSseFrame(buffer: string): { frame: string; rest: string } | undefined {
  const boundary = /\r?\n\r?\n/.exec(buffer);
  if (!boundary) return undefined;
  const end = boundary.index + boundary[0].length;
  return { frame: buffer.slice(0, end), rest: buffer.slice(end) };
}

function cloneFetchInput(input: URL | RequestInfo): URL | RequestInfo {
  return input instanceof Request ? input.clone() : input;
}

function doomLoopBackoff(random: () => number): number {
  return Math.min(250, Math.floor(Math.max(0, random()) * 251));
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

function xaiClientMode(): 'interactive' | 'headless' {
  return process.stdin.isTTY && process.stdout.isTTY ? 'interactive' : 'headless';
}

export function createXaiSubscriptionFetch(
  modelId: string,
  sessionId: string = randomUUID(),
  transport: typeof fetch = fetch,
  recoveryDependencies: XaiDoomLoopRecoveryDependencies = {},
): typeof fetch {
  if (modelId !== XAI_SUBSCRIPTION_MODEL) {
    throw new Error(`SuperGrok supports only ${XAI_SUBSCRIPTION_MODEL}`);
  }
  const conversationId = sessionId;
  const random = recoveryDependencies.random ?? Math.random;
  const sleep = recoveryDependencies.sleep ?? defaultSleep;
  const recoveryPolicy = resolveXaiDoomLoopRecoveryPolicy(
    recoveryDependencies.settings,
    recoveryDependencies.env,
  );

  return Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'https://cli-chat-proxy.grok.com' || url.pathname !== '/v1/responses') {
        throw new Error('Refusing to send a SuperGrok credential to an unexpected endpoint');
      }
      let requestBody = init?.body;
      const requestAttempt = async (): Promise<Response> => {
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
        if (recoveryPolicy) {
          headers.set('x-grok-doom-loop-check', String(recoveryPolicy.windowTokens));
        }
        const attemptInit: RequestInit = {
          ...init,
          headers,
          redirect: 'error',
        };
        if (requestBody !== undefined) attemptInit.body = requestBody;
        return transport(cloneFetchInput(input), attemptInit);
      };

      const firstResponse = await requestAttempt();
      if (
        !firstResponse.ok
        || !firstResponse.body
        || !firstResponse.headers.get('content-type')?.includes('text/event-stream')
      ) return firstResponse;

      let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            let response = firstResponse;
            let retryCount = 0;

            for (;;) {
              if (!response.body) throw new Error('xAI recovery response has no stream body');
              activeReader = response.body.getReader();
              const decoder = new TextDecoder();
              const encoder = new TextEncoder();
              const bufferedFrames: string[] = [];
              let pending = '';
              let committed = false;
              let frameDecision: FrameDecision = { kind: 'continue' };

              const flushBuffered = () => {
                for (const frame of bufferedFrames) controller.enqueue(encoder.encode(frame));
                bufferedFrames.length = 0;
              };

              const processFrame = (rawFrame: string): FrameDecision => {
                const frame = parseSseFrame(rawFrame);
                const labels = triggerLabels(frame.payload);
                const confidentLabels = confidentThinkingLoops(labels, recoveryPolicy);
                const confident = confidentLabels.length > 0;
                const recoveryBudgetAvailable = retryCount < (recoveryPolicy?.maxRetries ?? 0);
                if (isDoomLoopCheckFrame(frame)) {
                  if (confident && recoveryBudgetAvailable) {
                    if (committed) {
                      return { kind: 'fail', triggers: confidentLabels };
                    }
                    return { kind: 'retry' };
                  }
                  if (confident && !committed) {
                    flushBuffered();
                    committed = true;
                  }
                  // xAI's typed client always swallows this private control event.
                  return { kind: 'continue' };
                }
                if (
                  confident
                  && !committed
                  && recoveryBudgetAvailable
                ) {
                  return { kind: 'retry' };
                }
                if (confident && committed && recoveryBudgetAvailable) {
                  return { kind: 'fail', triggers: confidentLabels };
                }
                if (committed) {
                  controller.enqueue(encoder.encode(rawFrame));
                } else if (commitsProviderOutput(frame.payload)) {
                  flushBuffered();
                  committed = true;
                  controller.enqueue(encoder.encode(rawFrame));
                } else {
                  bufferedFrames.push(rawFrame);
                }
                return { kind: 'continue' };
              };

              while (frameDecision.kind === 'continue') {
                const { done, value } = await activeReader.read();
                pending += decoder.decode(value, { stream: !done });
                let next = nextSseFrame(pending);
                while (next) {
                  frameDecision = processFrame(next.frame);
                  pending = next.rest;
                  if (frameDecision.kind !== 'continue') break;
                  next = nextSseFrame(pending);
                }
                if (done) {
                  if (pending) frameDecision = processFrame(pending);
                  if (frameDecision.kind === 'continue') {
                    flushBuffered();
                    controller.close();
                    return;
                  }
                  break;
                }
              }

              if (frameDecision.kind === 'fail') {
                await activeReader.cancel('xAI doom loop detected after output committed');
                throw new Error(
                  `xAI doom loop detected after output committed: ${frameDecision.triggers.join(', ')}`,
                );
              }

              await activeReader.cancel('xAI doom-loop recovery resample');
              retryCount += 1;
              requestBody = appendDoomLoopRecoveryReminder(requestBody);
              await sleep(doomLoopBackoff(random));
              response = await requestAttempt();
              if (
                !response.ok
                || !response.body
                || !response.headers.get('content-type')?.includes('text/event-stream')
              ) throw new Error(`xAI doom-loop recovery request failed (HTTP ${response.status})`);
            }
          })().catch(error => controller.error(error));
        },
        cancel(reason) {
          return activeReader?.cancel(reason);
        },
      });
      const responseHeaders = new Headers(firstResponse.headers);
      responseHeaders.delete('content-length');
      return new Response(body, {
        status: firstResponse.status,
        statusText: firstResponse.statusText,
        headers: responseHeaders,
      });
    },
    { preconnect: fetch.preconnect },
  );
}
