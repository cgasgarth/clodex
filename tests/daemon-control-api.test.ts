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
  DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS,
  DASHBOARD_USAGE_REQUEST_TIMEOUT_MS,
  PROVIDER_METADATA_TIMEOUT_MS,
} from '../src/config/timeouts.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('daemon control API', () => {
  it('keeps each timeout above the slower downstream operation', () => {
    expect(PROVIDER_METADATA_TIMEOUT_MS).toBe(60_000);
    expect(DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(DASHBOARD_USAGE_REQUEST_TIMEOUT_MS).toBeGreaterThan(PROVIDER_METADATA_TIMEOUT_MS);
    expect(DAEMON_CONTROL_IDLE_TIMEOUT_SECONDS * 1_000)
      .toBeGreaterThan(DASHBOARD_USAGE_REQUEST_TIMEOUT_MS);
  });

  it('identifies the timed-out control endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );
    try {
      await expect(daemonControlRequest('/v1/status', {
        socketPath: '/tmp/clodex-test.sock',
        timeoutMs: 1,
      })).rejects.toThrow(
        /Clodex daemon request timed out after \d+ms \(budget 1ms\): GET \/v1\/status/,
      );
      await expect(daemonControlRequest(
        '/v1/metrics?accountId=private-account&start=private-date',
        { socketPath: '/tmp/clodex-test.sock', timeoutMs: 1 },
      )).rejects.toThrow(
        /GET \/v1\/metrics\?accountId&start$/,
      );
    } finally {
      fetchMock.mockRestore();
    }
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
    const createLaunchTicket = vi.fn((_accountId?: string, processingMode = 'standard') => ({
      ticket: 'opaque',
      accountIds: { 'openai-oauth': 'one' },
      accountLabel: 'One',
      // SAFETY: The test fixture defines the asserted runtime shape.
      processingMode: processingMode as 'standard' | 'fast',
    }));
    let secondwindMode: 'off' | 'on' = 'off';
    const secondwindSnapshot = () => ({
      mode: secondwindMode,
      since: new Date(0).toISOString(),
      loaded: false,
      sessions: 0,
      applied: {
        requests: 0,
        pricedRequests: 0,
        unpricedRequests: 0,
        blocksRewritten: 0,
        inputTokensConsidered: 0,
        tokensReduced: 0,
        estimatedTokenRequests: 0,
        estimatedSavingsUsd: 0,
      },
      lifetime: {
        requests: 0,
        blocksRewritten: 0,
        inputTokensConsidered: 0,
        tokensReduced: 0,
        estimatedTokenRequests: 0,
        estimatedSavingsUsd: 0,
      },
      topSessions: [],
      latency: { samples: 0, medianMs: 0, p95Ms: 0 },
      errors: 0,
    });
    const runtime = createDaemonRuntimeState({
      pid: process.pid,
      bunPath: process.execPath,
      cliPath: '/tmp/clodex/cli.js',
      ready: true,
      port: 12346,
      controlSocketPath: socketPath,
      version: 'test',
    });
    let nativeCompactionEnabled = true;
    const setNativeCompactionEnabled = vi.fn((enabled: boolean) => {
      if (enabled === nativeCompactionEnabled) return false;
      nativeCompactionEnabled = enabled;
      return true;
    });
    const requestRestart = vi.fn();
    const handle = await startDaemonControlApi({
      socketPath,
      runtime,
      collector,
      accounts: {
        list: () => [{ id: 'one', email: 'one@example.com', selected: true }],
        select,
        createLaunchTicket,
      },
      secondwind: {
        snapshot: secondwindSnapshot,
        setMode: mode => {
          secondwindMode = mode;
        },
      },
      nativeCompaction: {
        snapshot: () => ({ enabled: nativeCompactionEnabled }),
        setEnabled: setNativeCompactionEnabled,
      },
      requestRestart,
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
        port: number;
      }>(
        '/v1/status',
        { socketPath },
      );
      expect(status).toMatchObject({
        running: true,
        port: 12346,
      });
      await expect(daemonControlRequest('/v1/native-compaction', { socketPath }))
        .resolves.toEqual({ enabled: true });
      await expect(daemonControlRequest('/v1/native-compaction', {
        socketPath,
        method: 'POST',
        body: { enabled: true },
      })).resolves.toEqual({ enabled: true });
      expect(requestRestart).not.toHaveBeenCalled();
      await expect(daemonControlRequest('/v1/native-compaction', {
        socketPath,
        method: 'POST',
        body: { enabled: false },
      })).resolves.toEqual({ enabled: false });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(setNativeCompactionEnabled).toHaveBeenCalledWith(false);
      expect(requestRestart).toHaveBeenCalledTimes(1);
      await expect(daemonControlRequest('/v1/native-compaction', {
        socketPath,
        method: 'POST',
        body: { enabled: 'false' },
      })).rejects.toThrow('Native compaction enabled must be a boolean');
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
      expect(await daemonControlRequest('/v1/secondwind', { socketPath }))
        .toMatchObject({ mode: 'off' });
      expect(await daemonControlRequest('/v1/secondwind/mode', {
        socketPath,
        method: 'POST',
        body: { mode: 'on' },
      })).toMatchObject({ mode: 'on' });
      await expect(daemonControlRequest('/v1/secondwind/mode', {
        socketPath,
        method: 'POST',
        body: { mode: 'invalid' },
      })).rejects.toThrow('Secondwind mode must be off or on');
      await expect(daemonControlRequest(
        `/v1/metrics?start=${encodeURIComponent(new Date(now - 3_600_000).toISOString())}`
        + `&end=${encodeURIComponent(new Date(now).toISOString())}`
        + '&bucketMinutes=invalid',
        { socketPath },
      )).rejects.toThrow('bucketMinutes must be a finite number');
      const launch = await daemonControlRequest<{
        ticket: string;
        accountIds: Record<string, string>;
      }>('/v1/launches/attach', {
        socketPath,
        method: 'POST',
        body: {},
      });
      expect(launch.ticket).toBe('opaque');
      expect(launch.accountIds).toEqual({ 'openai-oauth': 'one' });
      expect(createLaunchTicket).toHaveBeenLastCalledWith(undefined, 'standard');
      const fastLaunch = await daemonControlRequest<{
        processingMode: string;
      }>('/v1/launches/attach', {
        socketPath,
        method: 'POST',
        body: { accountId: 'one', fast: true },
      });
      expect(fastLaunch.processingMode).toBe('fast');
      expect(createLaunchTicket).toHaveBeenLastCalledWith('one', 'fast');
      await expect(daemonControlRequest('/v1/launches/attach', {
        socketPath,
        method: 'POST',
        body: { fast: 'yes' },
      })).rejects.toThrow('Launch fast mode must be a boolean');
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
