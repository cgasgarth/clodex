/** Runtime representation checks used at untyped I/O boundaries. */
export function isString<T>(value: T): value is T & string {
  return typeof value === 'string';
}

export function isNumber<T>(value: T): value is T & number {
  return typeof value === 'number';
}

export function isBoolean<T>(value: T): value is T & boolean {
  return typeof value === 'boolean';
}

type Callable = (...args: never[]) => void;

export function isFunction<T>(value: T): value is Extract<T, Callable> {
  return typeof value === 'function';
}

export function isObject<T>(value: T): value is T & object {
  return value !== null && typeof value === 'object';
}

export function isUndefined<T>(value: T): value is T & undefined {
  return typeof value === 'undefined';
}

export function isSymbol<T>(value: T): value is T & symbol {
  return typeof value === 'symbol';
}

export function isBigInt<T>(value: T): value is T & bigint {
  return typeof value === 'bigint';
}
