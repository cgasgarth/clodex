import { describe, expect, it } from 'bun:test';
import {
  buildClaudeModelPickerOptions,
  readClaudeDefaultModel,
  syncClaudeModelPickerSettings,
} from '../src/runtime/claude-settings.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const routes = [
  { aliasId: 'clodex:openai-oauth:gpt-5.6-sol[1m]', displayName: 'GPT-5.6 Sol (OpenAI)' },
  { aliasId: 'clodex:xai-oauth:grok-4.6', displayName: 'Grok 4.6 (SuperGrok)' },
];

describe('native Claude model picker settings', () => {
  it('uses an active short alias as the route identity and keeps unaliased routes', () => {
    expect(buildClaudeModelPickerOptions(routes, [
      { name: 'sol', routeId: 'clodex:openai-oauth:gpt-5.6-sol' },
      { name: 'missing', unavailableReason: 'target unavailable' },
    ])).toEqual([
      { model: 'sol', label: 'sol', description: 'GPT-5.6 Sol (OpenAI)' },
      {
        model: 'clodex:xai-oauth:grok-4.6',
        label: 'Grok 4.6 (SuperGrok)',
        description: 'clodex:xai-oauth:grok-4.6',
      },
    ]);
  });

  it('stores picker rows in Claude settings and preserves unrelated values', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clodex-claude-settings-')), 'settings.json');
    writeFileSync(path, '{"model":"sol","effortLevel":"high","modelPicker":{"replaceBuiltInOptions":true}}');

    expect(syncClaudeModelPickerSettings(
      routes.slice(0, 1),
      [{ name: 'sol', routeId: routes[0]!.aliasId }],
      path,
    )).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      model: 'sol',
      effortLevel: 'high',
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [{ model: 'sol', label: 'sol', description: 'GPT-5.6 Sol (OpenAI)' }],
      },
    });
    expect(syncClaudeModelPickerSettings(
      routes.slice(0, 1),
      [{ name: 'sol', routeId: routes[0]!.aliasId }],
      path,
    )).toBe(false);
    expect(readClaudeDefaultModel(path)).toBe('sol');
  });

  it('ignores an absent or non-string default model', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-claude-settings-'));
    const missing = join(root, 'missing.json');
    const invalid = join(root, 'invalid.json');
    writeFileSync(invalid, '{"model":42}');

    expect(readClaudeDefaultModel(missing)).toBeUndefined();
    expect(readClaudeDefaultModel(invalid)).toBeUndefined();
  });

  it('does not create settings for an empty catalog', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clodex-claude-settings-')), 'settings.json');
    expect(syncClaudeModelPickerSettings([], [], path)).toBe(false);
  });
});
