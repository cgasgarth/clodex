// src/runtime/launch.ts
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAppPathOverride } from '../config/config.js';
import { findBinaryOnPath } from './binary-lookup.js';
import { isFunction } from './type-guards.js';

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

/** Version reported when the installed claude cannot be probed. */
const FALLBACK_CLAUDE_VERSION = '2.1.183';

const VERSION_PROBE_TIMEOUT_MS = 30_000;

/**
 * Probe one Claude binary. Return null when it cannot run or has no version.
 */
function getClaudeVersionForBinary(binaryPath: string): string | null {
  try {
    // POSIX: exec the file directly so a path containing spaces still works.
    // Windows: `claude` is often a .cmd shim, which needs a shell — keep the
    // quoted shell invocation there.
    const result = isWindows
      ? execSync(`"${binaryPath}" --version`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: VERSION_PROBE_TIMEOUT_MS,
        })
      : execFileSync(binaryPath, ['--version'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: VERSION_PROBE_TIMEOUT_MS,
        });
    return result.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Version of the claude found on PATH (or via the configured overrides), with a
 * known-good fallback. This is a best-effort string for request metadata — it is
 * NOT the version of any particular file, because `findClaudeBinary()` can
 * return a wrapper shim that differs from the real installation.
 */
export function getInstalledClaudeVersion(): string {
  const claudePath = findClaudeBinary();
  if (!claudePath) return FALLBACK_CLAUDE_VERSION;
  return getClaudeVersionForBinary(claudePath) ?? FALLBACK_CLAUDE_VERSION;
}

export function buildClaudeArgs(model: string | undefined, extraArgs: string[]): string[] {
  return model ? ['--model', model, ...extraArgs] : [...extraArgs];
}

export function launchClaude(
  env: NodeJS.ProcessEnv,
  model: string | undefined,
  extraArgs: string[],
): Promise<number> {
  return new Promise((resolve) => {
    const claudePath = findClaudeBinary()!;
    const args = buildClaudeArgs(model, extraArgs);

    const debugFileIdx = extraArgs.indexOf('--debug-file');
    const debugLogPath = debugFileIdx !== -1 && extraArgs[debugFileIdx + 1] ? extraArgs[debugFileIdx + 1] : undefined;

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    const muteWrite = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      if (isFunction(encodingOrCallback)) {
        callback = encodingOrCallback;
      }
      if (debugLogPath) {
        try {
          const str = chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk;
          appendFileSync(debugLogPath, `[parent] ${str}`);
        } catch {
          // ignore
        }
      }
      if (callback) callback();
      return true;
    };

    process.stdout.write = muteWrite;
    process.stderr.write = muteWrite;

    const restore = () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    };

    const child = spawn(claudePath, args, {
      stdio: 'inherit',
      env,
      shell: isWindows,
    });

    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };

    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));

    child.on('exit', (code) => {
      restore();
      resolve(code ?? 0);
    });

    child.on('error', () => {
      restore();
      resolve(1);
    });
  });
}
