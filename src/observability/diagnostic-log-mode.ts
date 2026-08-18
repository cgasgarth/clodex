import type { DiagnosticLogMode } from '../types.js';

const ERROR_OUTCOMES = new Set([
  'budget_exhausted',
  'candidate_failed',
  'exhausted',
  'failed',
  'internal_failure',
  'rejected',
]);

export function diagnosticLogMode(value: string | null | undefined): DiagnosticLogMode {
  return value === 'all' ? 'all' : 'error';
}

type DiagnosticEventValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | DiagnosticEventValue[]
  | { [key: string]: DiagnosticEventValue };

export interface DiagnosticEvent {
  [key: string]: DiagnosticEventValue;
  event?: string;
  outcome?: string;
  statusCode?: number;
}

/** True only for actionable transport/provider failures, never routine lifecycle noise. */
export function isErrorDiagnosticEvent(event: DiagnosticEvent): boolean {
  const name = event.event?.toLowerCase() ?? '';
  const outcome = event.outcome?.toLowerCase() ?? '';
  const statusCode = event.statusCode;
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
  event: DiagnosticEvent,
): boolean {
  return mode === 'all' || isErrorDiagnosticEvent(event);
}
