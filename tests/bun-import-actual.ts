const registryKey = Symbol.for('clodex.bun.actualModules');

/** Bun's module mock factory has no Vitest-style importOriginal callback. */
export function importActual<T>(specifier: string, parentUrl: string): T {
  const registry = (globalThis as Record<PropertyKey, unknown>)[registryKey] as
    | Map<string, unknown>
    | undefined;
  const resolved = specifier.startsWith('node:')
    ? specifier
    : import.meta.resolve(specifier, parentUrl);
  if (!registry?.has(resolved)) {
    throw new Error(`Bun test actual-module registry is missing ${resolved}`);
  }
  return registry.get(resolved) as T;
}
