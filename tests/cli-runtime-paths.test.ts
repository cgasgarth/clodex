import { describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCliRuntimePaths } from '../src/cli/runtime-paths.js';

describe('CLI runtime paths', () => {
  it('resolves the executable facade and process wrapper from extracted source modules', () => {
    const paths = resolveCliRuntimePaths(new URL('../src/cli/args.ts', import.meta.url).href);

    expect(paths.cliPath).toBe(realpathSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url))));
    expect(paths.processWrapperPath).toBe(
      realpathSync(fileURLToPath(new URL('../src/claude-wrapper.ts', import.meta.url))),
    );
  });
});
