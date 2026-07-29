import { mkdtempSync, rmSync } from 'node:fs';
import * as actualOs from 'node:os';
import { join } from 'node:path';
import { mock, vi } from 'bun:test';

const pristineOs = { ...actualOs };
const sandboxRoot = mkdtempSync(join(pristineOs.tmpdir(), 'clodex-bun-sandbox-'));
const sandboxHome = join(sandboxRoot, 'clodex-home');
const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

process.env.CLODEX_HOME = sandboxHome;
process.env.HOME = sandboxRoot;
process.env.CLODEX_CREDENTIAL_STORE = 'file';
process.env.CLODEX_TEST_REAL_HOME = pristineOs.userInfo().homedir;

mock.module('node:os', () => ({
  ...pristineOs,
  userInfo: () => ({
    ...pristineOs.userInfo(),
    homedir: sandboxRoot,
  }),
}));

const actualModuleRegistry = new Map<string, unknown>([
  ['node:fs', { ...await import('node:fs') }],
  ['node:os', pristineOs],
]);
const testFileUrl = new URL('./preload-placeholder.test.ts', import.meta.url).href;
for (const specifier of [
  '@clack/prompts',
  '../src/env.js',
  '../src/oauth/responses-websocket.js',
  '../src/openai-adapter.js',
  '../src/provider-factory.js',
  '../src/registry/add-template.js',
  '../src/registry/provider-auth.js',
  '../src/sdk-adapter.js',
  '../src/server-runtime.js',
]) {
  const resolved = import.meta.resolve(specifier, testFileUrl);
  actualModuleRegistry.set(resolved, await import(resolved));
}
Object.defineProperty(globalThis, Symbol.for('clodex.bun.actualModules'), {
  configurable: false,
  value: actualModuleRegistry,
});

async function waitFor(
  assertion: () => unknown | Promise<unknown>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 10;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  do {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(interval);
    }
  } while (Date.now() < deadline);
  throw lastError;
}

Object.assign(vi, {
  mocked: <T>(value: T): T => value,
  hoisted: <T>(factory: () => T): T => factory(),
  waitFor,
  stubGlobal: (name: PropertyKey, value: unknown): void => {
    if (!originalGlobals.has(name)) {
      originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  },
  unstubAllGlobals: (): void => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originalGlobals.clear();
  },
  advanceTimersByTimeAsync: async (milliseconds: number): Promise<void> => {
    vi.advanceTimersByTime(milliseconds);
  },
  runOnlyPendingTimersAsync: async (): Promise<void> => {
    vi.runOnlyPendingTimers();
  },
  doMock: vi.mock,
  doUnmock: (): void => {},
  resetModules: (): void => {},
  importActual: <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>,
});

process.once('exit', () => {
  delete process.env.CLODEX_TEST_REAL_HOME;
  rmSync(sandboxRoot, { recursive: true, force: true });
});
