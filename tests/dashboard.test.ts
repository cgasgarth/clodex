import { describe, expect, it } from 'bun:test';
import {
  accountDisplayName,
  cyclePeriod,
  deviceCodeInstruction,
  diagnosticLines,
  formatUsd,
  lineChart,
  loadDashboardPanels,
  loadUsageMetrics,
  secondwindPercentSaved,
  secondwindSessionSummary,
  secondwindTokenSummary,
  usageRange,
  usageMetricsPath,
  usagePeriodLabel,
  VIEW_SWITCH_HINT,
  type DashboardRequest,
} from '../src/dashboard-data.js';
import { DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS } from '../src/timeouts.js';

describe('dashboard usage chart', () => {
  it('renders visible x and y axes with activity points', () => {
    const range = usageRange('day', 0, new Date(2026, 6, 29, 12));
    const chart = lineChart([0, 5, 10], range, { width: 3, height: 3 });
    expect(chart.some(line => line.includes('┤'))).toBe(true);
    expect(chart.some(line => line.includes('└───'))).toBe(true);
    expect(chart.join('\n')).toContain('●');
  });

  it('uses a zero y-axis for an empty range', () => {
    const range = usageRange('last30', -1, new Date(2026, 6, 29, 12));
    const chart = lineChart([], range, {
      width: 3,
      height: 3,
      formatY: formatUsd,
    });
    expect(chart[0]).toContain('$0.00');
    expect(chart.join('\n')).not.toContain('$1.00');
  });

  it('navigates day and rolling 7-day and 30-day ranges', () => {
    const now = new Date(2026, 6, 29, 12);
    expect(usageRange('day', -1, now).start.getDate()).toBe(28);
    expect(usageRange('last7', 0, now).start.getDate()).toBe(23);
    expect(usageRange('last7', 0, now).end.getDate()).toBe(30);
    expect(usageRange('last7', -1, now).start.getDate()).toBe(16);
    expect(usageRange('last30', 0, now).start.getMonth()).toBe(5);
    expect(usageRange('last30', 0, now).start.getDate()).toBe(30);
    expect(usageRange('last30', -1, now).start.getMonth()).toBe(4);
    expect(usageRange('last30', -1, now).start.getDate()).toBe(31);
    expect(cyclePeriod('day', 1)).toBe('last7');
    expect(cyclePeriod('day', -1)).toBe('last30');
    expect(usagePeriodLabel('last7')).toBe('LAST 7 DAYS');
    expect(usagePeriodLabel('last30')).toBe('LAST 30 DAYS');
  });

  it('formats small API-equivalent costs without rounding them away', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(12.345)).toBe('$12.35');
  });

  it('filters usage to the active account or aggregates all accounts', () => {
    const range = usageRange('last7', 0, new Date(2026, 6, 29, 12));
    const activePath = usageMetricsPath(range, 'active', 'account-1');
    const allPath = usageMetricsPath(range, 'all', 'account-1');

    expect(activePath).toContain('accountId=account-1');
    expect(allPath).not.toContain('accountId=');
    expect(usageMetricsPath(range, 'active')).toBeUndefined();
  });

  it('loads and validates all-account usage without an account filter', async () => {
    const range = usageRange('day', 0, new Date(2026, 6, 29, 12));
    const calls: string[] = [];
    const request: DashboardRequest = async <T>(path: string): Promise<T> => {
      calls.push(path);
      return {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        buckets: [],
      } as T;
    };
    const buckets = await loadUsageMetrics(range, 'all', 'ignored', request);

    expect(buckets).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('accountId=');
  });
});

describe('dashboard account identity', () => {
  it('uses only the OpenAI email and never a legacy account label', () => {
    expect(accountDisplayName({ email: 'person@example.com' })).toBe('person@example.com');
    expect(accountDisplayName({})).toBe('Email unavailable');
  });
});

describe('dashboard device-code login', () => {
  it('renders the complete device code independently of refresh status', () => {
    expect(deviceCodeInstruction({
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI',
    })).toBe('Enter code ABCD-EFGHI in the browser.');
  });
});

describe('dashboard controls', () => {
  it('explicitly tells users to press the numbered view keys', () => {
    expect(VIEW_SWITCH_HINT).toBe('Press 1–6 to switch views');
  });

  it('shows compaction lifecycle, thread identity, sizes, and duration', () => {
    expect(diagnosticLines({
      timestamp: '2026-08-06T06:09:39.288Z',
      kind: 'ws_compaction',
      requestId: 'compact-request',
      sessionId: '10a1f5d9-490e-4444-911d-ecc365a07bad',
      threadName: 'typing cleanup efforts continued',
      detail: {
        outcome: 'completed',
        stage: 1,
        transport: 'responses_compact_endpoint',
        reason: 'known_oversized',
        estimatedInputTokens: 910_173,
        inputTokens: 194_383,
        outputTokens: 4_627,
        estimatedRebasedTokens: 684_341,
        durationMs: 93_897,
      },
    })).toEqual([
      expect.stringContaining('compaction completed · stage 1'),
      'thread typing cleanup efforts continued · 10a1f5d9-490e-4444-911d-ecc365a07bad',
      'input 194.4K · compact output 4.6K · resulting context 684.3K · raw transcript 910.2K',
      'duration 1m 34s · responses_compact_endpoint · known_oversized',
    ]);
  });

  it('labels native Secondwind token accounting as measured', () => {
    expect(secondwindTokenSummary({
      requests: 1,
      pricedRequests: 1,
      unpricedRequests: 0,
      blocksRewritten: 1,
      inputTokensConsidered: 1_503,
      tokensReduced: 732,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0.001,
    })).toBe('732 tool-output tokens compacted · measured by Secondwind');
  });

  it('labels compatibility token accounting as estimated', () => {
    expect(secondwindTokenSummary({
      requests: 2,
      pricedRequests: 2,
      unpricedRequests: 0,
      blocksRewritten: 1,
      inputTokensConsidered: 4_000,
      tokensReduced: 1_200,
      estimatedTokenRequests: 1,
      estimatedSavingsUsd: 0.002,
    })).toBe('~1.2K tool-output tokens compacted · 1 fallback estimate');
  });

  it('reports measured input-token reduction as a percentage', () => {
    expect(secondwindPercentSaved({
      inputTokensConsidered: 4_000,
      tokensReduced: 1_000,
    })).toBe('25%');
    expect(secondwindPercentSaved({
      inputTokensConsidered: 0,
      tokensReduced: 0,
    })).toBe('0%');
  });

  it('formats ranked current-daemon session savings', () => {
    expect(secondwindSessionSummary({
      sessionHash: '1234567890abcdef',
      requests: 4,
      pricedRequests: 4,
      unpricedRequests: 0,
      blocksRewritten: 8,
      inputTokensConsidered: 50_000,
      tokensReduced: 12_345,
      estimatedTokenRequests: 0,
      estimatedSavingsUsd: 0.042,
    }, 0)).toBe(
      '1. session 12345678 · 12.3K tokens (24.7% of tool output saved) · $0.042 estimated savings · 4 req',
    );
  });
});

describe('dashboard refresh resilience', () => {
  const status = {
    running: true,
    ready: true,
    version: 'test',
    pid: 123,
    uptimeSeconds: 60,
    port: 17_647,
    websocket: {
      total: 0,
      open: 0,
      inFlight: 0,
      established: 0,
      nursery: 0,
      isolated: 0,
      partitions: 0,
      checkpoints: 0,
    },
    activeSessions: 0,
    sessions: [],
  };

  function requestFrom(
    responses: Record<string, unknown | Error>,
    calls: Array<{ path: string; timeoutMs?: number }> = [],
  ): DashboardRequest {
    return async <T>(path: string, options = {}): Promise<T> => {
      calls.push({ path, timeoutMs: options.timeoutMs });
      const response = responses[path];
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error(`Unexpected request: ${path}`);
      return response as T;
    };
  }

  it('keeps a healthy daemon available when an optional panel fails', async () => {
    const snapshot = await loadDashboardPanels(requestFrom({
      '/v1/status': status,
      '/v1/accounts': new Error('accounts timed out'),
      '/v1/diagnostics?limit=20': { diagnostics: [] },
      '/v1/secondwind': {},
      '/v1/claude/models': { models: [] },
    }));

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.status).toEqual(status);
    expect(snapshot.accounts).toBeUndefined();
    expect(snapshot.warnings).toContain('accounts: accounts timed out');
  });

  it('uses health as the availability fallback when status is delayed', async () => {
    const snapshot = await loadDashboardPanels(requestFrom({
      '/v1/status': new Error('status timed out'),
      '/v1/health': { ok: true },
      '/v1/accounts': new Error('accounts timed out'),
      '/v1/diagnostics?limit=20': new Error('diagnostics timed out'),
      '/v1/secondwind': new Error('Secondwind timed out'),
      '/v1/claude/models': new Error('models timed out'),
    }));

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.status).toBeUndefined();
    expect(snapshot.warnings).toContain('status: status timed out');
  });

  it('treats any successful control panel as proof the daemon is reachable', async () => {
    const calls: Array<{ path: string; timeoutMs?: number }> = [];
    const snapshot = await loadDashboardPanels(requestFrom({
      '/v1/status': new Error('status timed out'),
      '/v1/accounts': { accounts: [] },
      '/v1/diagnostics?limit=20': new Error('diagnostics timed out'),
      '/v1/secondwind': new Error('Secondwind timed out'),
      '/v1/claude/models': new Error('models timed out'),
    }, calls));

    expect(snapshot.reachable).toBe(true);
    expect(calls.some(call => call.path === '/v1/health')).toBe(false);
  });

  it('reports unavailable only when both status and health fail', async () => {
    const snapshot = await loadDashboardPanels(requestFrom({
      '/v1/status': new Error('status timed out'),
      '/v1/health': new Error('health timed out'),
      '/v1/accounts': new Error('accounts timed out'),
      '/v1/diagnostics?limit=20': new Error('diagnostics timed out'),
      '/v1/secondwind': new Error('Secondwind timed out'),
      '/v1/claude/models': new Error('models timed out'),
    }));

    expect(snapshot.reachable).toBe(false);
    expect(snapshot.warnings).toContain('health: health timed out');
  });

  it('gives every routine panel the dashboard control timeout budget', async () => {
    const calls: Array<{ path: string; timeoutMs?: number }> = [];
    await loadDashboardPanels(requestFrom({
      '/v1/status': status,
      '/v1/accounts': { accounts: [] },
      '/v1/diagnostics?limit=20': { diagnostics: [] },
      '/v1/secondwind': {},
      '/v1/claude/models': { models: [] },
    }, calls));

    expect(calls).toHaveLength(5);
    expect(calls.every(call =>
      call.timeoutMs === DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS)).toBe(true);
  });
});
