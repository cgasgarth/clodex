import { describe, expect, it } from 'bun:test';
import {
  diagnosticLogMode,
  isErrorDiagnosticEvent,
  shouldWriteDiagnosticEvent,
} from '../src/diagnostic-log-mode.js';

describe('diagnostic log modes', () => {
  it('defaults malformed or missing configuration to error mode', () => {
    expect(diagnosticLogMode(undefined)).toBe('error');
    expect(diagnosticLogMode('verbose')).toBe('error');
    expect(diagnosticLogMode('all')).toBe('all');
  });

  it('retains every lifecycle event in all mode', () => {
    expect(shouldWriteDiagnosticEvent('all', {
      event: 'ws_compaction', outcome: 'started',
    })).toBe(true);
    expect(shouldWriteDiagnosticEvent('all', {
      event: 'ws_head_decision', decision: 'continuation',
    })).toBe(true);
  });

  it('retains only actionable failures in error mode', () => {
    expect(isErrorDiagnosticEvent({
      event: 'ws_compaction', outcome: 'started',
    })).toBe(false);
    expect(isErrorDiagnosticEvent({
      event: 'ws_compaction', outcome: 'completed',
    })).toBe(false);
    expect(isErrorDiagnosticEvent({
      event: 'ws_compaction', outcome: 'failed', failureClass: 'timeout_or_transport',
    })).toBe(true);
    expect(isErrorDiagnosticEvent({
      event: 'ws_response_protocol_anomaly', anomaly: 'late_delta',
    })).toBe(true);
    expect(shouldWriteDiagnosticEvent('error', {
      event: 'ws_head_decision', decision: 'continuation',
    })).toBe(false);
  });
});
