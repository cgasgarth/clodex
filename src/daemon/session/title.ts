import { isString } from '../../runtime/type-guards.js';
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TITLE_TAIL_BYTES = 256 * 1024;

interface CachedTitle {
  path: string;
  size: number;
  mtimeMs: number;
  title?: string;
}

const cache = new Map<string, CachedTitle>();

function projectsRoot(): string {
  const claudeConfig = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  return join(claudeConfig, 'projects');
}

function findTranscript(sessionId: string, root: string): string | undefined {
  const cached = cache.get(sessionId)?.path;
  if (cached) return cached;
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const candidate = join(root, project.name, `${sessionId}.jsonl`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue through other Claude project directories.
      }
    }
  } catch {
    // Session titles are optional diagnostics.
  }
  return undefined;
}

function titleFromJsonl(text: string): string | undefined {
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('title')) continue;
    try {
      const record: { type?: string; aiTitle?: string; customTitle?: string } = JSON.parse(line);
      if (record.type === 'ai-title' && isString(record.aiTitle)) {
        aiTitle = record.aiTitle.trim() || aiTitle;
      }
      if (record.type === 'custom-title' && isString(record.customTitle)) {
        customTitle = record.customTitle.trim() || customTitle;
      }
    } catch {
      // A tail read can start in the middle of one JSONL record.
    }
  }
  return customTitle ?? aiTitle;
}

function readTail(path: string, size: number): string {
  const length = Math.min(size, TITLE_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const file = openSync(path, 'r');
  try {
    readSync(file, buffer, 0, length, size - length);
  } finally {
    closeSync(file);
  }
  return buffer.toString('utf8');
}

/** Resolve Claude's local display title without reading conversation content into diagnostics. */
export function resolveClaudeSessionTitle(
  sessionId: string,
  root = projectsRoot(),
): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const path = findTranscript(sessionId, root);
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    const cached = cache.get(sessionId);
    if (cached?.path === path && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.title;
    }
    const tail = readTail(path, stat.size);
    const title = titleFromJsonl(tail)
      ?? (stat.size > TITLE_TAIL_BYTES ? titleFromJsonl(readFileSync(path, 'utf8')) : undefined);
    cache.set(sessionId, { path, size: stat.size, mtimeMs: stat.mtimeMs, title });
    return title;
  } catch {
    return undefined;
  }
}

export function resetClaudeSessionTitleCacheForTests(): void {
  cache.clear();
}
