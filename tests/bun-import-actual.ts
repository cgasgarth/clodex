import { createRequire } from 'node:module';

const requireActual = createRequire(import.meta.url);

/** Bun's module mock factory has no Vitest-style importOriginal callback. */
export function importActual<T>(specifier: string, parentUrl: string): T {
  const resolved = specifier.startsWith('node:')
    ? specifier
    : import.meta.resolve(specifier, parentUrl);
  if (specifier.startsWith('node:')) return requireActual(specifier) as T;
  return requireActual(`${resolved}?clodex-actual`) as T;
}
