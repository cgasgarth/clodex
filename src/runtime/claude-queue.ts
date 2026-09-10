import { watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isObject, isString } from './type-guards.js';
import { claudeQueuedEventKind } from '../claude-queued-events.js';
import type { QueuedSessionInput } from '../oauth/responses-websocket/steering.js';

export interface ClaudeQueueSubscription {
  flush(): Promise<void>;
  close(): void;
}

function readQueuedInput(line: string, sessionId: string, position: string): QueuedSessionInput | undefined {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return undefined; }
  if (!isObject(row) || !('type' in row) || row.type !== 'queue-operation'
    || !('operation' in row) || row.operation !== 'enqueue'
    || !('sessionId' in row) || row.sessionId !== sessionId
    || !('content' in row) || !isString(row.content)) return undefined;
  return { id: createHash('sha256').update(`${position}:${line}`).digest('hex'),
    kind: claudeQueuedEventKind(row.content) === 'task' ? 'task' : 'human', text: row.content };
}

/** Follow only new queue records from the active Claude transcript. Never edit or consume Claude's queue. */
export async function watchClaudeQueue(
  sessionId: string,
  onInput: (input: QueuedSessionInput) => void,
  projectsPath = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects'),
): Promise<ClaudeQueueSubscription> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('Invalid Claude session id');
  const matches = await Array.fromAsync(new Bun.Glob(`*/${sessionId}.jsonl`).scan({ cwd: projectsPath, absolute: true }));
  if (matches.length !== 1) throw new Error('No unique Claude transcript for this local session');
  const path = matches[0]!;
  const file = await open(path, 'r');
  let offset = (await file.stat()).size;
  let pending = '';
  let decoder = new TextDecoder();
  let stopped = false;
  const isStopped = () => stopped;
  let reading: Promise<void> | undefined;
  let dirty = false;
  const deliverLine = (line: string): void => {
    const input = readQueuedInput(line, sessionId, `${path}:${offset - Buffer.byteLength(pending)}`);
    if (input) onInput(input);
  };
  const readAvailable = async (): Promise<void> => {
    while (dirty && !isStopped()) {
      dirty = false;
      const size = (await file.stat()).size;
      if (size < offset) { offset = size; pending = ''; decoder = new TextDecoder(); }
      while (offset < size && !isStopped()) {
        const buffer = Buffer.alloc(Math.min(size - offset, 64 * 1024));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          deliverLine(line);
        }
      }
    }
  };
  const drain = (): Promise<void> => {
    dirty = true;
    reading ??= readAvailable().finally(() => { reading = undefined; });
    return reading;
  };
  const watcher = watch(path, () => { void drain().catch(() => {}); });
  watcher.unref();
  return { flush: drain, close: () => { stopped = true; watcher.close(); void file.close(); } };
}
