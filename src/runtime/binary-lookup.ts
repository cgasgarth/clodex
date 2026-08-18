import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface FindBinaryOnPathOptions {
  verifyWhichResult?: boolean;
  isWindows?: boolean;
  exists?: (path: string) => boolean;
  runWhich?: (name: string, isWindows: boolean) => string;
}

export function findBinaryOnPath(
  name: string,
  fallbackPaths: string[],
  options: FindBinaryOnPathOptions = {},
): string | null {
  const isWindows = options.isWindows ?? process.platform === 'win32';
  const exists = options.exists ?? existsSync;
  // argv form, never a shell string — the binary name must not be shell-interpretable
  // (defense-in-depth originally added in d887984, must survive refactors).
  const runWhich = options.runWhich ?? ((binary, win) =>
    execFileSync(win ? 'where.exe' : 'which', [binary], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }));

  try {
    const lines = runWhich(name, isWindows)
      .trim()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const path = (isWindows ? lines.find(line => line.toLowerCase().endsWith('.cmd')) : null)
      ?? lines[0];
    if (path && (!options.verifyWhichResult || exists(path))) return path;
  } catch {
    // Fall through to fallback paths.
  }

  for (const path of fallbackPaths) {
    if (exists(path)) return path;
  }
  return null;
}
