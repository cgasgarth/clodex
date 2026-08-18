// pkce.ts — shared PKCE helpers for OAuth device/browser flows

export function positiveSecondsToMs<Value>(value: Value, defaultMs: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}

export async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}
