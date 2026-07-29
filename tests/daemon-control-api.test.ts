import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { DaemonInferenceCollector } from '../src/daemon/collector.js';
import { daemonControlRequest } from '../src/daemon/control-client.js';
import { startDaemonControlApi } from '../src/daemon/control-api.js';
import { DaemonMetricsStore } from '../src/daemon/metrics.js';
import { createDaemonRuntimeState } from '../src/daemon/runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('daemon control API', () => {
  it('serves status, metrics, accounts, selection, and launch tickets over an owner socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clodex-control-'));
    roots.push(root);
    const socketPath = join(root, 'control.sock');
    const collector = new DaemonInferenceCollector(
      new DaemonMetricsStore(join(root, 'metrics.jsonl')),
    );
    const select = vi.fn();
    const requestStop = vi.fn();
    const runtime = createDaemonRuntimeState({
      pid: process.pid,
      bunPath: process.execPath,
      cliPath: '/tmp/clodex/cli.js',
      ready: true,
      proxyPort: 12345,
      endpointPort: 12346,
      caPath: '/tmp/ca.pem',
      controlSocketPath: socketPath,
      version: 'test',
    });
    const handle = await startDaemonControlApi({
      socketPath,
      runtime,
      collector,
      accounts: {
        list: () => [{ id: 'one', email: 'one@example.com', selected: true }],
        select,
        createLaunchTicket: () => ({
          ticket: 'opaque',
          accountId: 'one',
          accountLabel: 'One',
        }),
      },
      requestRestart: vi.fn(),
      requestStop,
    });
    try {
      const status = await daemonControlRequest<{
        running: boolean;
        proxyPort: number;
        endpointPort: number;
      }>(
        '/v1/status',
        { socketPath },
      );
      expect(status).toMatchObject({
        running: true,
        proxyPort: 12345,
        endpointPort: 12346,
      });
      const launch = await daemonControlRequest<{ ticket: string }>('/v1/launches/attach', {
        socketPath,
        method: 'POST',
        body: {},
      });
      expect(launch.ticket).toBe('opaque');
      await daemonControlRequest('/v1/accounts/one/select', {
        socketPath,
        method: 'POST',
      });
      expect(select).toHaveBeenCalledWith('one');
      await expect(daemonControlRequest('/v1/service/stop', {
        socketPath,
        method: 'POST',
        body: { instanceId: 'stale' },
      })).rejects.toThrow('Daemon instance changed');
      await daemonControlRequest('/v1/service/stop', {
        socketPath,
        method: 'POST',
        body: { instanceId: runtime.instanceId },
      });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(requestStop).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });
});
