const REMINDER_START = '<system-reminder>\n';
const REMINDER_END = '\n</system-reminder>';
const HUMAN_PREFIX = 'The user sent a new message while you were working:\n';
const HUMAN_SUFFIX = 'Address the message above as you continue this turn.';
const TASK_PREFIX = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n';

export type ClaudeQueuedEventKind = 'human' | 'task';

/** Recognize Claude's queue envelopes without changing their contents. */
export function claudeQueuedEventKind(text: string): ClaudeQueuedEventKind | undefined {
  let body = text.trim();
  if (body.startsWith(REMINDER_START) && body.endsWith(REMINDER_END)) {
    body = body.slice(REMINDER_START.length, -REMINDER_END.length).trim();
  }
  if (body.startsWith(HUMAN_PREFIX) && body.endsWith(HUMAN_SUFFIX)) return 'human';
  if (
    (body.startsWith('<task-notification>')
      || (body.startsWith(TASK_PREFIX) && body.includes('\n\n<task-notification>')))
    && body.endsWith('</task-notification>')
  ) return 'task';
  return undefined;
}

export interface ClaudeQueuedEvent {
  kind: ClaudeQueuedEventKind;
  text: string;
}

/**
 * Claude 2.1.261 appends mid-turn attachments to the next tool result. Inspect
 * only its trailing reminder blocks, not tags embedded in ordinary tool data.
 * Keep unrelated reminders and tool data in their original channel.
 */
export function splitClaudeQueuedToolText(text: string) {
  let end = text.length;
  const suffix: Array<{ start: number; end: number; event?: ClaudeQueuedEvent }> = [];
  while (end > 0 && text.slice(0, end).endsWith(REMINDER_END)) {
    const start = text.lastIndexOf(REMINDER_START, end - REMINDER_END.length);
    if (start < 0 || (start > 0 && text.slice(start - 2, start) !== '\n\n')) break;
    const block = text.slice(start, end);
    const kind = claudeQueuedEventKind(block);
    const from = start === 0 ? 0 : start - 2;
    suffix.unshift({ start: from, end, ...(kind && { event: { kind, text: block } }) });
    end = from;
  }
  return {
    toolText: text.slice(0, end) + suffix.filter(part => !part.event)
      .map(part => text.slice(part.start, part.end)).join(''),
    events: suffix.flatMap(part => part.event ? [part.event] : []),
  };
}
