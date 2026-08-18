import { vi } from 'bun:test';
import type { AddressInfo } from 'node:net';

const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

type JsonScalar = boolean | null | number | string;
export type JsonValue = JsonObject | JsonScalar | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export function asMocked<T>(value: T): T {
  return value;
}

export function createHoisted<T>(factory: () => T): T {
  return factory();
}

export async function waitForCondition<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? 1_000);
  const interval = options.interval ?? 10;
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

export function stubTestGlobal<T>(name: PropertyKey, value: T): void {
  if (!originalGlobals.has(name)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

export function restoreTestGlobals(): void {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
}

export function requireTcpAddress(
  address: AddressInfo | string | null,
  message: string,
): AddressInfo {
  if (!(address instanceof Object)) throw new Error(message);
  return address;
}

export async function advanceTestTimersByTime(milliseconds: number): Promise<void> {
  vi.advanceTimersByTime(milliseconds);
}
