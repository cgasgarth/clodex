// Shared tool-input normalization for the Anthropic translation and Responses
// continuation snapshot. These paths must use one rule so a tool call can
// match the sanitized value that Claude Code later echoes.

import type { ProviderDataValue } from './types.js';

/** Remove optional filler values while keeping required empty values. */
export function sanitizeToolInput(
  input: Readonly<Record<string, ProviderDataValue>>,
  requiredProps?: ReadonlySet<string>,
): Record<string, ProviderDataValue> {
  // A null prototype keeps model-controlled keys such as `__proto__` as data.
  const output: Record<string, ProviderDataValue> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (value === null) continue;
    if (
      (value === '' || (Array.isArray(value) && value.length === 0))
      && !requiredProps?.has(key)
    ) continue;
    output[key] = value;
  }
  return output;
}
