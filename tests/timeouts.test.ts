import { describe, expect, it } from 'bun:test';
import {
  DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS,
  DASHBOARD_USAGE_REQUEST_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  MODEL_TOTAL_TIMEOUT_MS,
  NATIVE_COMPACTION_TIMEOUT_MS,
  OPENAI_METADATA_TIMEOUT_MS,
  PROVIDER_METADATA_TIMEOUT_MS,
} from '../src/timeouts.js';

describe('long-running operation timeouts', () => {
  it('keeps user work on generous, ordered budgets', () => {
    expect(PROVIDER_METADATA_TIMEOUT_MS).toBe(60_000);
    expect(OPENAI_METADATA_TIMEOUT_MS).toBe(PROVIDER_METADATA_TIMEOUT_MS);
    expect(DASHBOARD_USAGE_REQUEST_TIMEOUT_MS).toBe(90_000);
    expect(DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS * 1_000).toBe(120_000);
    expect(MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(10 * 60_000);
    expect(NATIVE_COMPACTION_TIMEOUT_MS).toBe(10 * 60_000);
    expect(MODEL_TOTAL_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
