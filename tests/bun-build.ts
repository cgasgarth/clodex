import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildBunTestEntry(
  entrypoint: string,
  outdir: string,
  outputName: string,
): Promise<string> {
  await mkdir(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: 'bun',
    format: 'esm',
    packages: 'external',
    sourcemap: 'none',
    naming: outputName,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Bun failed to build ${entrypoint}`);
  }
  return join(outdir, outputName);
}
