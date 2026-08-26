import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { DaemonAccountStore } from '../src/daemon/account-store.js';
import { DaemonInferenceCollector } from '../src/daemon/collector.js';
import { daemonControlRequest } from '../src/daemon/control-client.js';
import { startIsolatedDaemonControlApi } from '../src/daemon/control/isolated.js';
import { DaemonMetricsStore } from '../src/daemon/metrics.js';
import { createDaemonRuntimeState } from '../src/daemon/runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function childOutput(socketPath: string): Promise<string> {
  const child = spawn(process.execPath, [
    new URL('./fixtures/isolated-control-client.ts', import.meta.url).pathname,
    socketPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`isolated control client exited ${code}: ${stderr}`));
    });
  });
}

describe('isolated daemon control plane', () => {
  it('serves health and launch tickets while the inference event loop is blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-control-isolation-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    // SAFETY: The test fixture defines the asserted runtime shape.
    const env = { ...process.env, CLODEX_HOME: root } satisfies NodeJS.ProcessEnv;
    new DaemonAccountStore(env).add({
      label: 'test@example.com',
      email: 'test@example.com',
      authRef: 'test-auth',
    });
    const collector = new DaemonInferenceCollector(
      new DaemonMetricsStore(join(root, 'metrics.sqlite')),
    );
    const runtime = createDaemonRuntimeState({
      pid: process.pid,
      bunPath: process.execPath,
      cliPath: '/tmp/clodex/cli.js',
      ready: true,
      port: 17647,
      controlSocketPath: socketPath,
      version: 'test',
    });
    const setDiagnosticLogMode = vi.fn();
    const handle = await startIsolatedDaemonControlApi({
      socketPath,
      runtime,
      collector,
      accounts: {
        list: () => [],
        select: vi.fn(),
        createLaunchTicket: () => null,
      },
      secondwind: {
        // SAFETY: The test fixture defines the asserted runtime shape.
        snapshot: () => ({ mode: 'on' }) as never,
        setMode: vi.fn(),
      },
      nativeCompaction: {
        snapshot: () => ({ enabled: true }),
        setEnabled: vi.fn(() => false),
      },
      diagnosticLogs: {
        snapshot: () => ({ mode: 'error' }),
        setMode: setDiagnosticLogMode,
      },
      requestRestart: vi.fn(),
      requestStop: vi.fn(),
      workerEnv: env,
    });
    try {
      const output = childOutput(socketPath);
      const blockedUntil = performance.now() + 1_500;
      while (performance.now() < blockedUntil) {
        // Simulate synchronous parsing/rebasing of an unusually large transcript.
      }
      // SAFETY: The test fixture defines the asserted runtime shape.
      const result = JSON.parse(await output) as {
        durationMs: number;
        healthStatus: number;
        attachStatus: number;
        attach: { ticket?: string };
      };
      expect(result.healthStatus).toBe(200);
      expect(result.attachStatus).toBe(201);
      expect(result.attach.ticket).toMatch(/^[^.]+\.[^.]+$/);
      expect(result.durationMs).toBeLessThan(750);
      await expect(daemonControlRequest('/v1/status', { socketPath }))
        .resolves.toMatchObject({ ready: true, port: 17647 });
      await expect(daemonControlRequest('/v1/diagnostics/mode', {
        socketPath,
        method: 'POST',
        body: { mode: 'all' },
      })).resolves.toMatchObject({ mode: 'error' });
      expect(setDiagnosticLogMode).toHaveBeenCalledWith('all');
      await expect(daemonControlRequest('/v1/diagnostics/mode', {
        socketPath,
        method: 'POST',
        body: { mode: 'verbose' },
      })).rejects.toThrow('Diagnostic log mode must be all or error');
    } finally {
      await handle.close();
      collector.metrics.close();
    }
  });
});
