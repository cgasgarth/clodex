import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CliRuntimePaths {
  cliPath: string;
  processWrapperPath: string;
}

/** Resolve stable source or bundled entry paths from any CLI module. */
export function resolveCliRuntimePaths(moduleUrl: string): CliRuntimePaths {
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  if (basename(modulePath) === 'cli.js' && basename(dirname(modulePath)) === 'dist') {
    return {
      cliPath: modulePath,
      processWrapperPath: join(dirname(modulePath), 'claude-wrapper.js'),
    };
  }

  const sourceRoot = basename(dirname(modulePath)) === 'cli'
    ? resolve(dirname(modulePath), '..')
    : dirname(modulePath);
  const sourceCli = join(sourceRoot, 'cli.ts');
  const sourceWrapper = join(sourceRoot, 'claude-wrapper.ts');
  if (existsSync(sourceCli) && existsSync(sourceWrapper)) {
    return {
      cliPath: realpathSync(sourceCli),
      processWrapperPath: realpathSync(sourceWrapper),
    };
  }

  return {
    cliPath: modulePath,
    processWrapperPath: join(dirname(modulePath), 'claude-wrapper.js'),
  };
}
