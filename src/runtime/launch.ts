// src/runtime/launch.ts
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAppPathOverride } from '../config/config.js';
import { findBinaryOnPath } from './binary-lookup.js';

const isWindows = process.platform === 'win32';

function fallbackPaths(): string[] {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir();
  return isWindows
    ? [
        join(process.env['APPDATA'] ?? home, 'npm', 'claude.cmd'),
        join(process.env['APPDATA'] ?? home, 'npm', 'claude'),
        join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      ]
    : [
        join(home, '.local', 'bin', 'claude'),
        join(home, '.npm', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];
}

export function findClaudeBinary(): string | null {
  const environmentOverride = process.env['CLODEX_CLAUDE_PATH'];
  if (environmentOverride?.trim()) {
    return existsSync(environmentOverride) ? environmentOverride : null;
  }

  const override = getAppPathOverride('claude');
  if (override) return existsSync(override) ? override : null;

  return findBinaryOnPath('claude', fallbackPaths());
}

export function buildClaudeArgs(model: string | undefined, extraArgs: string[]): string[] {
  return model ? ['--model', model, ...extraArgs] : [...extraArgs];
}
