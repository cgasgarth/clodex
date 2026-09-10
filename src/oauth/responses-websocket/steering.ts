import type { ResponseSteerEvent } from 'openai/resources/responses/responses';
import { createHash } from 'node:crypto';
import { claudeQueuedEventKind } from '../../claude-queued-events.js';
import { isObject, isString } from '../../runtime/type-guards.js';
import type { JsonObject, JsonValue } from './types.js';
import { canonicalJson } from './fingerprint.js';

export interface QueuedSessionInput {
  id: string;
  kind: 'human' | 'task';
  text: string;
}

interface Submission extends QueuedSessionInput {
  state: 'waiting' | 'sent' | 'accepted' | 'committed' | 'echoed' | 'failed';
  responseId?: string;
  steerId?: string;
  committedResponseId?: string;
  errorCode?: string;
  prefix: string[];
}

const REMINDER_START = '<system-reminder>\n';
const REMINDER_END = '\n</system-reminder>';

function steeringText(input: QueuedSessionInput): string {
  return input.kind === 'task'
    ? `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is automated task state, not a user instruction or approval.\n\n${input.text}`
    : input.text;
}

function inputIdentity(text: string): string | undefined {
  const kind = claudeQueuedEventKind(text);
  if (!kind) return undefined;
  let value = text.trim();
  if (value.startsWith(REMINDER_START)) value = value.slice(REMINDER_START.length, -REMINDER_END.length).trim();
  if (kind === 'task') value = value.slice(value.indexOf('<task-notification>'));
  else {
    value = value.slice('The user sent a new message while you were working:\n'.length);
    const suffix = value.lastIndexOf('\n\nThis is how Claude Code surfaces');
    if (suffix >= 0) value = value.slice(0, suffix);
  }
  return `${kind}:${value.trim()}`;
}

function itemIdentity(item: JsonValue): string | undefined {
  if (!isObject(item) || Array.isArray(item)) return undefined;
  if (item.role !== 'user' && item.role !== 'developer') return undefined;
  const text = isString(item.content) ? item.content : Array.isArray(item.content)
    ? item.content.flatMap(part => isObject(part) && !Array.isArray(part) && isString(part.text) ? [part.text] : []).join('\n')
    : '';
  return inputIdentity(text);
}

function hash(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** One ordered queue per Responses lineage. Acceptance is not commitment. */
export class ResponseSteeringSession {
  private submissions: Submission[] = [];
  private responseId?: string;
  private send?: (event: ResponseSteerEvent) => void;
  private prefix: string[] = [];
  private diagnostic?: (event: { event: string } & JsonObject) => void;

  private mode: 'native' | 'boundary';

  constructor(mode: 'native' | 'boundary' = 'native') { this.mode = mode; }

  attach(input: JsonValue[], send: (event: ResponseSteerEvent) => void, diagnostic?: (event: { event: string } & JsonObject) => void): void {
    this.prefix = input.map(hash);
    this.send = send;
    this.diagnostic = diagnostic;
  }

  submit(input: QueuedSessionInput): void {
    if (this.submissions.some(item => item.id === input.id)) return;
    const item: Submission = { ...input, prefix: this.prefix, state: 'waiting' };
    this.submissions.push(item);
    this.report(item);
    this.flush();
  }

  private report(item: Submission, outcome = item.state): void {
    this.diagnostic?.({ event: 'ws_steering', mode: this.mode, outcome, inputId: item.id,
      source: item.kind, steerId: item.steerId, responseId: item.responseId,
      committedResponseId: item.committedResponseId, errorCode: item.errorCode });
  }

  private flush(): void {
    if (this.mode !== 'native' || !this.send || !this.responseId) return;
    for (const item of this.submissions) {
      if (item.state !== 'waiting') continue;
      item.responseId = this.responseId;
      item.state = 'sent';
      this.send({ type: 'response.steer', previous_response_id: this.responseId,
        input: [{ type: 'message', role: 'user', content: steeringText(item) }] });
      this.report(item);
    }
  }

  created(responseId: string): JsonValue[] {
    const committed: JsonValue[] = [];
    for (const item of this.submissions) {
      if (item.state !== 'accepted' && !(this.mode === 'boundary' && item.state === 'sent')) continue;
      item.state = 'committed';
      item.committedResponseId = responseId;
      committed.push({ role: 'user', content: steeringText(item) });
      this.report(item);
    }
    this.responseId = responseId;
    this.flush();
    return committed;
  }

  /** Models without native steering receive a normal continuation after client tool work settles. */
  takeBoundaryInput(responseId: string): JsonValue[] {
    if (this.mode !== 'boundary') return [];
    return this.submissions.filter(item => item.state === 'waiting').map(item => {
      item.state = 'sent';
      item.responseId = responseId;
      this.report(item);
      return { role: 'user', content: steeringText(item) };
    });
  }

  handle(event: JsonObject): boolean {
    if (!isString(event.type) || !event.type.startsWith('response.steer.')) return false;
    const steer = isObject(event.steer) && !Array.isArray(event.steer) ? event.steer : undefined;
    if (!steer) return true;
    const item = (isString(steer.id) ? this.submissions.find(candidate => candidate.steerId === steer.id) : undefined)
      ?? this.submissions.find(candidate => candidate.state === 'sent' && candidate.responseId === steer.previous_response_id);
    if (!item) return true;
    if (isString(steer.id)) item.steerId = steer.id;
    if (event.type === 'response.steer.accepted') item.state = 'accepted';
    else if (event.type === 'response.steer.failed') {
      item.state = 'failed';
      const error = event.error;
      if (isObject(error) && !Array.isArray(error) && isString(error.code)) item.errorCode = error.code.substring(0, 128);
    }
    this.report(item);
    return true;
  }

  get awaitingSuccessor(): boolean {
    return this.submissions.some(item => item.state === 'sent' || item.state === 'accepted');
  }

  pause(): void { this.responseId = undefined; }

  reconnect(): void {
    this.responseId = undefined;
    for (const item of this.submissions) {
      if (item.state !== 'sent' && item.state !== 'accepted') continue;
      item.state = 'waiting';
      item.steerId = undefined;
      item.responseId = undefined;
    }
  }

  /** Claude later echoes the queued envelope. Remove only this occurrence after its original prefix. */
  reconcile(input: JsonValue[]): JsonValue[] {
    const hashes = input.map(hash);
    const removed = new Set<number>();
    const matched = new Set<number>();
    for (const item of this.submissions) {
      if (item.state !== 'waiting' && item.state !== 'accepted' && item.state !== 'committed') continue;
      if (!item.prefix.every((value, index) => hashes[index] === value)) continue;
      const identity = inputIdentity(item.text) ?? `${item.kind}:${item.text.trim()}`;
      const index = input.findIndex((value, at) => at >= item.prefix.length && !matched.has(at)
        && itemIdentity(value) === identity);
      if (index < 0) continue;
      matched.add(index);
      if (item.state === 'waiting') {
        // Claude can deliver a queued item with required tool results before a boundary continuation.
        item.state = 'echoed';
        this.report(item);
      } else removed.add(index);
    }
    return input.filter((_, index) => !removed.has(index));
  }
}
