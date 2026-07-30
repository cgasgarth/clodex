import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  createDaemonRuntimeState,
  readDaemonRuntimeState,
  removeDaemonRuntimeState,
  writeDaemonRuntimeState,
} from '../src/daemon/runtime.js';
import { getDaemonRuntimePath } from '../src/paths.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('daemon runtime state', () => {
  it('round-trips an owner-only versioned readiness record', () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-daemon-runtime-'));
    roots.push(root);
    const env = { CLODEX_HOME: root };
    const state = createDaemonRuntimeState({
      pid: process.pid,
      bunPath: process.execPath,
      cliPath: '/tmp/clodex/cli.js',
      ready: true,
      port: 12346,
      controlSocketPath: '/tmp/clodex.sock',
      version: 'test',
    });
    writeDaemonRuntimeState(state, env);
    expect(readDaemonRuntimeState(env)).toEqual(state);
    expect(statSync(getDaemonRuntimePath(env)).mode & 0o777).toBe(0o600);
    removeDaemonRuntimeState(state.instanceId, env);
    expect(readDaemonRuntimeState(env)).toBeNull();
  });
});
