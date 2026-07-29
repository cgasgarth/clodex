import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { DaemonInferenceCollector } from '../src/daemon/collector.js';
import { daemonControlRequest } from '../src/daemon/control-client.js';
import { startDaemonControlApi } from '../src/daemon/control-api.js';
import { DaemonMetricsStore } from '../src/daemon/metrics.js';
import { createDaemonRuntimeState } from '../src/daemon/runtime.js';
import {
  DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS,
  DASHBOARD_USAGE_REQUEST_TIMEOUT_MS,
  OPENAI_METADATA_TIMEOUT_MS,
} from '../src/timeouts.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('daemon control API', () => {
  it('keeps each timeout above the slower downstream operation', () => {
    expect(OPENAI_METADATA_TIMEOUT_MS).toBe(60_000);
    expect(DASHBOARD_USAGE_REQUEST_TIMEOUT_MS).toBeGreaterThan(OPENAI_METADATA_TIMEOUT_MS);
    expect(DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS * 1_000)
      .toBeGreaterThan(DASHBOARD_USAGE_REQUEST_TIMEOUT_MS);
  });

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
      const now = Date.now();
      collector.metrics.append({
        timestamp: new Date(now - 1_000).toISOString(),
        accountId: 'one',
        modelId: 'sol',
        provider: 'openai-oauth',
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheWriteTokens: 0,
        outputTokens: 10,
        error: false,
      });
      collector.metrics.append({
        timestamp: new Date(now - 1_000).toISOString(),
        accountId: 'two',
        modelId: 'luna',
        provider: 'openai-oauth',
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheWriteTokens: 0,
        outputTokens: 10,
        error: false,
      });
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
      const metrics = await daemonControlRequest<{
        accountId: string;
        buckets: Array<{ requests: number; inputTokens: number }>;
      }>(`/v1/metrics?start=${encodeURIComponent(new Date(now - 3_600_000).toISOString())}`
        + `&end=${encodeURIComponent(new Date(now).toISOString())}`
        + '&bucketMinutes=60&accountId=one', { socketPath });
      expect(metrics.accountId).toBe('one');
      expect(metrics.buckets).toEqual([
        expect.objectContaining({ requests: 1, inputTokens: 100 }),
      ]);
      await expect(daemonControlRequest(
        `/v1/metrics?start=${encodeURIComponent(new Date(now - 3_600_000).toISOString())}`
        + `&end=${encodeURIComponent(new Date(now).toISOString())}`
        + '&bucketMinutes=invalid',
        { socketPath },
      )).rejects.toThrow('bucketMinutes must be a finite number');
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
      collector.metrics.close();
    }
  });
});
