import type { DaemonRuntimeState } from '../runtime.js';

export interface SerializedControlRequest {
  id: number;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
}

export interface SerializedControlResponse {
  id: number;
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

export type ControlWorkerCommand =
  | {
      type: 'start';
      socketPath: string;
      runtime: DaemonRuntimeState;
    }
  | { type: 'response'; response: SerializedControlResponse }
  | { type: 'close' };

export type ControlWorkerEvent =
  | { type: 'ready' }
  | { type: 'request'; request: SerializedControlRequest }
  | { type: 'closed' }
  | { type: 'failed'; message: string };
