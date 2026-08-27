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
  {
    aliasId: 'clodex:openai-oauth:gpt-5.6-sol[1m]',
    displayName: 'GPT-5.6 Sol (OpenAI)',
    contextWindow: 1_000_000,
  },
  {
    aliasId: 'clodex:xai-oauth:grok-4.6',
    displayName: 'Grok 4.6 (SuperGrok)',
    contextWindow: 500_000,
  },
];

describe('native Claude model picker settings', () => {
  it('uses an active short alias as the route identity and keeps unaliased routes', () => {
    expect(buildClaudeModelPickerOptions(routes, [
      { name: 'sol', routeId: 'clodex:openai-oauth:gpt-5.6-sol' },
      { name: 'missing', unavailableReason: 'target unavailable' },
    ])).toEqual([
      { model: 'sol[1m]', label: 'sol', description: 'GPT-5.6 Sol (OpenAI)' },
      {
        model: 'clodex:xai-oauth:grok-4.6[1m]',
        label: 'Grok 4.6 (SuperGrok)',
        description: 'clodex:xai-oauth:grok-4.6',
      },
    ]);
  });

  it('stores picker rows in Claude settings and preserves unrelated values', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clodex-claude-settings-')), 'settings.json');
    writeFileSync(path, JSON.stringify({
      model: 'sol',
      effortLevel: 'high',
      env: {
        KEEP_ME: 'yes',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
        DISABLE_AUTO_COMPACT: '1',
      },
      modelPicker: { replaceBuiltInOptions: true },
    }));

    expect(syncClaudeModelPickerSettings(
      routes.slice(0, 1),
      [{ name: 'sol', routeId: routes[0]!.aliasId }],
      path,
    )).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      model: 'sol[1m]',
      effortLevel: 'high',
      env: {
        KEEP_ME: 'yes',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [{ model: 'sol[1m]', label: 'sol', description: 'GPT-5.6 Sol (OpenAI)' }],
      },
    });
    expect(syncClaudeModelPickerSettings(
      routes.slice(0, 1),
      [{ name: 'sol', routeId: routes[0]!.aliasId }],
      path,
    )).toBe(false);
    expect(readClaudeDefaultModel(path)).toBe('sol[1m]');
  });

  it('uses the smallest route window so mixed catalogs compact before every provider limit', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clodex-claude-settings-')), 'settings.json');
    writeFileSync(path, '{}');

    expect(syncClaudeModelPickerSettings(routes, [], path)).toBe(true);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    expect(settings.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBe('450000');
    expect(settings.env['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('1000000');
  });

  it('keeps the native 200K identity for a 200K-only catalog', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clodex-claude-settings-')), 'settings.json');
    const route = {
      aliasId: 'clodex:test:small',
      displayName: 'Small',
      contextWindow: 200_000,
    };
    writeFileSync(path, '{}');

    expect(syncClaudeModelPickerSettings([route], [], path)).toBe(true);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    expect(settings.modelPicker.options[0].model).toBe(route.aliasId);
    expect(settings.env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBe('180000');
    expect(settings.env['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('200000');
  });

  it('does not replace existing compaction settings without valid route windows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'clodex-claude-settings-')), 'settings.json');
    writeFileSync(path, JSON.stringify({
      env: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123000',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '456000',
        DISABLE_AUTO_COMPACT: '1',
      },
    }));

    expect(syncClaudeModelPickerSettings([
      { aliasId: 'clodex:test:unknown', displayName: 'Unknown' },
    ], [], path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).env).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123000',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '456000',
      DISABLE_AUTO_COMPACT: '1',
    });
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
