import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  resetClaudeSessionTitleCacheForTests,
  resolveClaudeSessionTitle,
} from '../src/daemon/session/title.js';

const roots: string[] = [];

afterEach(() => {
  resetClaudeSessionTitleCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveClaudeSessionTitle', () => {
  it('prefers the custom Claude thread title without returning transcript text', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-title-'));
    roots.push(root);
    const project = join(root, 'project');
    mkdirSync(project);
    const sessionId = '10a1f5d9-490e-4444-911d-ecc365a07bad';
    writeFileSync(join(project, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', message: 'private prompt text' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Chosen thread name' }),
    ].join('\n'));

    expect(resolveClaudeSessionTitle(sessionId, root)).toBe('Chosen thread name');
  });

  it('rejects unsafe session identifiers', () => {
    expect(resolveClaudeSessionTitle('../../private', '/tmp')).toBeUndefined();
  });
});
