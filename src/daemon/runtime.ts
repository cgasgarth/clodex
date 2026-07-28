import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getDaemonRuntimePath } from '../paths.js';

export const DAEMON_PROTOCOL_VERSION = 2;

export interface DaemonRuntimeState {
  protocolVersion: number;
  instanceId: string;
  pid: number;
  nodePath: string;
  cliPath: string;
  startedAt: string;
  ready: boolean;
  proxyPort: number;
  endpointPort: number;
  caPath: string;
  controlSocketPath: string;
  version: string;
}

interface HomeEnv {
  HOME?: string;
  CLODEX_HOME?: string;
  USERPROFILE?: string;
}

function validState(value: unknown): value is DaemonRuntimeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<DaemonRuntimeState>;
  return state.protocolVersion === DAEMON_PROTOCOL_VERSION
    && typeof state.instanceId === 'string'
    && state.instanceId.length > 0
    && Number.isInteger(state.pid)
    && (state.pid ?? 0) > 0
    && typeof state.nodePath === 'string'
    && state.nodePath.length > 0
    && typeof state.cliPath === 'string'
    && state.cliPath.length > 0
    && typeof state.startedAt === 'string'
    && typeof state.ready === 'boolean'
    && Number.isInteger(state.proxyPort)
    && (state.proxyPort ?? 0) > 0
    && (state.proxyPort ?? 0) <= 65_535
    && Number.isInteger(state.endpointPort)
    && (state.endpointPort ?? 0) > 0
    && (state.endpointPort ?? 0) <= 65_535
    && typeof state.caPath === 'string'
    && state.caPath.length > 0
    && typeof state.controlSocketPath === 'string'
    && state.controlSocketPath.length > 0
    && typeof state.version === 'string';
}

export function createDaemonRuntimeState(
  values: Omit<DaemonRuntimeState, 'protocolVersion' | 'instanceId' | 'startedAt'>,
): DaemonRuntimeState {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    ...values,
  };
}

export function readDaemonRuntimeState(env: HomeEnv = process.env): DaemonRuntimeState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getDaemonRuntimePath(env), 'utf8'));
    return validState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDaemonRuntimeState(
  state: DaemonRuntimeState,
  env: HomeEnv = process.env,
): void {
  const path = getDaemonRuntimePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function removeDaemonRuntimeState(
  instanceId?: string,
  env: HomeEnv = process.env,
): void {
  const path = getDaemonRuntimePath(env);
  if (instanceId) {
    const current = readDaemonRuntimeState(env);
    if (current && current.instanceId !== instanceId) return;
  }
  rmSync(path, { force: true });
}
