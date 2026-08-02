import type { DiagnosticLogMode } from './types.js';

const ERROR_OUTCOMES = new Set([
  'budget_exhausted',
  'candidate_failed',
  'exhausted',
  'failed',
  'internal_failure',
  'rejected',
]);

export function diagnosticLogMode(value: unknown): DiagnosticLogMode {
  return value === 'all' ? 'all' : 'error';
}

/** True only for actionable transport/provider failures, never routine lifecycle noise. */
export function isErrorDiagnosticEvent(event: Record<string, unknown>): boolean {
  const name = typeof event.event === 'string' ? event.event.toLowerCase() : '';
  const outcome = typeof event.outcome === 'string' ? event.outcome.toLowerCase() : '';
  const statusCode = typeof event.statusCode === 'number' ? event.statusCode : undefined;
  return Boolean(
    (statusCode !== undefined && statusCode >= 400)
    || event.failureClass
    || event.errorCode
    || name.includes('error')
    || name.includes('failed')
    || name.includes('protocol_anomaly')
    || ERROR_OUTCOMES.has(outcome)
  );
}

export function shouldWriteDiagnosticEvent(
  mode: DiagnosticLogMode,
  event: Record<string, unknown>,
): boolean {
  return mode === 'all' || isErrorDiagnosticEvent(event);
}
