import { createRequire } from 'node:module';

const requireActual = createRequire(import.meta.url);

/** Bun's module mock factory has no Vitest-style importOriginal callback. */
export function importActual<T>(specifier: string, parentUrl: string): T {
  const resolved = specifier.startsWith('node:')
    ? specifier
    : import.meta.resolve(specifier, parentUrl);
  // SAFETY: The test fixture defines the asserted runtime shape.
  if (specifier.startsWith('node:')) {
    return /* SAFETY: The caller supplies the imported Node module contract. */ requireActual(specifier) as T;
  }
  // SAFETY: The test fixture defines the asserted runtime shape.
  return /* SAFETY: The caller supplies the imported module contract. */ requireActual(`${resolved}?clodex-actual`) as T;
}
