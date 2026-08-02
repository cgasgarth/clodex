import {
  withResponsesWebSocketDiagnosticContext as runWithDiagnosticContext,
} from '../types.js';
import type {
  ResponsesWebSocketDiagnosticContext as InternalDiagnosticContext,
} from '../types.js';
import {
  responsesWebSocketPoolSnapshot as readPoolSnapshot,
} from '../state.js';
import type {
  ResponsesWebSocketPoolSnapshot as InternalPoolSnapshot,
} from '../state.js';

export interface ResponsesWebSocketDiagnosticContext extends InternalDiagnosticContext {}

export function withResponsesWebSocketDiagnosticContext<T>(
  context: ResponsesWebSocketDiagnosticContext,
  fn: () => T,
): T {
  return runWithDiagnosticContext(context, fn);
}

export type {
  ResponsesWebSocketDiagnosticEvent,
  ResponsesWebSocketFetchOptions,
} from '../types.js';
export { resetResponsesWebSocketConnectionsForTests } from '../state.js';

export interface ResponsesWebSocketPoolSnapshot extends InternalPoolSnapshot {}

export function responsesWebSocketPoolSnapshot(): ResponsesWebSocketPoolSnapshot {
  return readPoolSnapshot();
}

export {
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFingerprint,
} from '../fingerprint.js';
