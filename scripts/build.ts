import { watch } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    watch: { type: 'boolean', default: false },
  },
});

async function build(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: [
      'src/cli.ts',
      'src/claude-wrapper.ts',
      'src/daemon/control/worker.ts',
      'src/daemon/secondwind-worker.ts',
    ],
    outdir: 'dist',
    target: 'bun',
    format: 'esm',
    packages: 'external',
    sourcemap: 'external',
    naming: '[name].js',
    banner: '#!/usr/bin/env bun',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  await Promise.all(result.outputs
    .filter(output => output.path.endsWith('.js'))
    .map(output => chmod(output.path, 0o755)));
  return true;
}

await rm('dist', { recursive: true, force: true });
if (!await build()) process.exit(1);

if (values.watch) {
  console.error('clodex: watching src/');
  let pending = false;
  let building = false;
  const hasPendingBuild = () => pending;
  const rebuild = async (): Promise<void> => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    do {
      pending = false;
      const started = performance.now();
      const success = await build();
      console.error(`clodex: ${success ? 'rebuilt' : 'build failed'} in ${Math.round(performance.now() - started)}ms`);
    } while (hasPendingBuild());
    building = false;
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  watch('src', { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void rebuild(), 50);
  });
  await new Promise(() => {});
}
