import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { daemonControlRequest } from './daemon/control-client.js';
import { DASHBOARD_USAGE_REQUEST_TIMEOUT_MS } from './timeouts.js';
import {
  loginOpenAiAccount,
  logoutOpenAiAccount,
} from './daemon/account-command.js';
import {
  API_PRICING_AS_OF,
  API_PRICING_SOURCE,
} from './daemon/api-pricing.js';
import type {
  SecondwindModeMetrics,
  SecondwindSessionSavings,
  SecondwindSnapshot,
} from './daemon/secondwind.js';
import type { SecondwindMode } from './types.js';

interface WebSocketStatus {
  total: number;
  open: number;
  inFlight: number;
  established: number;
  nursery: number;
  isolated: number;
  partitions: number;
  checkpoints: number;
}

interface SessionStatus {
  sessionHash: string;
  modelId: string;
  provider: string;
  lastActivityAt: string;
  activeRequests: number;
  completedRequests: number;
  cancelledRequests: number;
  failedRequests: number;
}

interface DaemonStatus {
  running: boolean;
  ready: boolean;
  version: string;
  pid: number;
  uptimeSeconds: number;
  port: number;
  websocket: WebSocketStatus;
  activeSessions: number;
  sessions: SessionStatus[];
}

export interface MetricBucket {
  timestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  requests: number;
  errors: number;
  cancellations: number;
  durationMs: number;
  inputCost: number;
  cacheCost: number;
  outputCost: number;
  totalCost: number;
  pricedRequests: number;
  unpricedRequests: number;
  standardRequests: number;
  fastRequests: number;
  standardCost: number;
  fastCost: number;
}

interface Account {
  id: string;
  email?: string;
  selected: boolean;
  plan?: string;
  usage?: {
    primaryUsedPercent?: number;
    primaryResetAt?: number;
    weeklyUsedPercent?: number;
    weeklyResetAt?: number;
    stale?: boolean;
    error?: string;
  };
}

interface Diagnostic {
  timestamp: string;
  kind: string;
  code?: string;
  statusCode?: number;
}

export interface DeviceCodePrompt {
  url: string;
  userCode: string;
}

export type UsagePeriod = 'day' | 'week' | 'month';
type DashboardView = 'overview' | 'usage' | 'accounts' | 'diagnostics' | 'secondwind';

export interface UsageRange {
  period: UsagePeriod;
  offset: number;
  start: Date;
  end: Date;
  label: string;
  bucketMinutes: number;
}

const VIEWS: DashboardView[] = ['overview', 'usage', 'accounts', 'diagnostics', 'secondwind'];
const SECONDWIND_MODES: SecondwindMode[] = ['off', 'shadow', 'on'];
const PERIODS: UsagePeriod[] = ['day', 'week', 'month'];
const CHART_WIDTH = 56;
const CHART_HEIGHT = 6;
export const VIEW_SWITCH_HINT = 'Press 1–5 to switch views';

export function secondwindTokenSummary(
  metrics: Pick<SecondwindModeMetrics, 'tokensReduced' | 'estimatedTokenRequests'> | undefined,
): string {
  const tokens = compactNumber(metrics?.tokensReduced ?? 0);
  const estimatedRequests = metrics?.estimatedTokenRequests ?? 0;
  return estimatedRequests > 0
    ? `~${tokens} tool-output tokens compacted · ${estimatedRequests} fallback estimate${estimatedRequests === 1 ? '' : 's'}`
    : `${tokens} tool-output tokens compacted · measured by Secondwind`;
}

export function secondwindPercentSaved(
  metrics: Pick<SecondwindModeMetrics, 'tokensReduced' | 'inputTokensConsidered'> | undefined,
): string {
  const input = metrics?.inputTokensConsidered ?? 0;
  if (input <= 0) return '0%';
  const percent = Math.min(100, Math.max(0, (metrics?.tokensReduced ?? 0) / input * 100));
  return `${percent.toFixed(percent >= 10 ? 1 : 2).replace(/\.?0+$/, '')}%`;
}

export function secondwindSessionSummary(
  session: SecondwindSessionSavings,
  index: number,
): string {
  const estimate = session.estimatedTokenRequests > 0 ? '~' : '';
  return `${index + 1}. session ${session.sessionHash.slice(0, 8)}`
    + ` · ${estimate}${compactNumber(session.tokensReduced)} tokens`
    + ` (${secondwindPercentSaved(session)} input)`
    + ` · ${formatUsd(session.estimatedSavingsUsd)} estimated savings`
    + ` · ${session.requests} req`;
}

export function accountDisplayName(account: Pick<Account, 'email'>): string {
  return account.email ?? 'Email unavailable';
}

export function deviceCodeInstruction({ userCode }: DeviceCodePrompt): string {
  return `Enter code ${userCode} in the browser.`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const mondayOffset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - mondayOffset);
  return day;
}

export function usageRange(
  period: UsagePeriod,
  offset = 0,
  now = new Date(),
): UsageRange {
  let start: Date;
  let end: Date;
  let label: string;
  if (period === 'day') {
    start = startOfDay(now);
    start.setDate(start.getDate() + offset);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
    label = start.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } else if (period === 'week') {
    start = startOfWeek(now);
    start.setDate(start.getDate() + offset * 7);
    end = new Date(start);
    end.setDate(end.getDate() + 7);
    const inclusiveEnd = new Date(end);
    inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
    label = `${start.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })} – ${inclusiveEnd.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`;
  } else {
    start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    label = start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  return { period, offset, start, end, label, bucketMinutes: 60 };
}

export function cyclePeriod(
  period: UsagePeriod,
  direction: 1 | -1,
): UsagePeriod {
  const index = PERIODS.indexOf(period);
  return PERIODS[(index + direction + PERIODS.length) % PERIODS.length]!;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatLatency(value: number): string {
  if (value < 1) return `${value.toFixed(2)}ms`;
  if (value < 100) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
}

function sampledValues(values: number[], width: number): number[] {
  if (values.length <= width) return values;
  return Array.from({ length: width }, (_, index) => {
    const start = Math.floor(index * values.length / width);
    const end = Math.max(start + 1, Math.floor((index + 1) * values.length / width));
    return values.slice(start, end).reduce((sum, value) => sum + value, 0);
  });
}

function axisDate(date: Date, period: UsagePeriod): string {
  return period === 'day'
    ? date.toLocaleTimeString(undefined, { hour: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function lineChart(
  values: number[],
  range: Pick<UsageRange, 'start' | 'end' | 'period'>,
  options: {
    width?: number;
    height?: number;
    formatY?: (value: number) => string;
  } = {},
): string[] {
  const width = options.width ?? CHART_WIDTH;
  const height = options.height ?? CHART_HEIGHT;
  const formatY = options.formatY ?? compactNumber;
  const sampled = sampledValues(values, width);
  const padded = sampled.length === 0 ? [0] : sampled;
  const max = Math.max(0, ...padded);
  const plotWidth = Math.max(1, padded.length);
  const grid = Array.from(
    { length: height },
    () => Array.from({ length: plotWidth }, () => ' '),
  );
  padded.forEach((value, index) => {
    const normalized = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    const row = height - 1 - Math.round(normalized * (height - 1));
    grid[row]![index] = '●';
  });
  const yLabelWidth = Math.max(
    formatY(max).length,
    formatY(max / 2).length,
    formatY(0).length,
  );
  const lines = grid.map((row, index) => {
    const value = max * (height - 1 - index) / Math.max(1, height - 1);
    const showLabel = index === 0 || index === Math.floor((height - 1) / 2) || index === height - 1;
    const label = showLabel ? formatY(value).padStart(yLabelWidth) : ' '.repeat(yLabelWidth);
    return `${label} ┤${row.join('')}`;
  });
  lines.push(`${' '.repeat(yLabelWidth)} └${'─'.repeat(plotWidth)}`);
  const middle = new Date((range.start.getTime() + range.end.getTime()) / 2);
  const startLabel = axisDate(range.start, range.period);
  const middleLabel = axisDate(middle, range.period);
  const endLabel = axisDate(new Date(range.end.getTime() - 1), range.period);
  const innerWidth = Math.max(
    plotWidth,
    startLabel.length + middleLabel.length + endLabel.length + 2,
  );
  const leftGap = Math.max(1, Math.floor((innerWidth - startLabel.length - middleLabel.length - endLabel.length) / 2));
  const rightGap = Math.max(1, innerWidth - startLabel.length - middleLabel.length - endLabel.length - leftGap);
  lines.push(
    `${' '.repeat(yLabelWidth + 2)}${startLabel}${' '.repeat(leftGap)}${middleLabel}${' '.repeat(rightGap)}${endLabel}`,
  );
  return lines;
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function resetLabel(epochSeconds: number | undefined): string {
  if (!epochSeconds) return 'unknown reset';
  const seconds = Math.max(0, epochSeconds - Date.now() / 1000);
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86_400)}d`;
}

function UsageBar({
  label,
  used,
  resetAt,
}: {
  label: string;
  used: number | undefined;
  resetAt: number | undefined;
}): React.ReactNode {
  const normalized = Math.max(0, Math.min(100, used ?? 0));
  const filled = Math.round((100 - normalized) / 5);
  return (
    <Text>
      {label.padEnd(8)} <Text color="cyan">{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(20 - filled)}</Text>
      {' '}{String(Math.round(100 - normalized)).padStart(3)}% left · {resetLabel(resetAt)}
    </Text>
  );
}

function Chart({
  title,
  values,
  range,
  color,
  formatY,
}: {
  title: string;
  values: number[];
  range: UsageRange;
  color: string;
  formatY?: (value: number) => string;
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {lineChart(values, range, { formatY }).map((line, index) => (
        <Text key={`${title}-${index}`} color={color}>{line}</Text>
      ))}
    </Box>
  );
}

function ViewTabs({ view }: { view: DashboardView }): React.ReactNode {
  return (
    <Text>
      {VIEWS.map((candidate, index) => (
        <React.Fragment key={candidate}>
          {index > 0 ? '  ' : ''}
          <Text
            bold={candidate === view}
            color={candidate === view ? 'cyan' : undefined}
            inverse={candidate === view}
          >
            {index + 1} {candidate[0]!.toUpperCase() + candidate.slice(1)}
          </Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

function Dashboard(): React.ReactNode {
  const { exit } = useApp();
  const [view, setView] = useState<DashboardView>('overview');
  const [period, setPeriod] = useState<UsagePeriod>('day');
  const [periodOffset, setPeriodOffset] = useState(0);
  const [rangeNow, setRangeNow] = useState(() => new Date());
  const range = useMemo(
    () => usageRange(period, periodOffset, rangeNow),
    [period, periodOffset, rangeNow],
  );
  const refreshSequence = useRef(0);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [metrics, setMetrics] = useState<MetricBucket[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [secondwind, setSecondwind] = useState<SecondwindSnapshot | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState('Connecting to Clodex daemon…');
  const [loading, setLoading] = useState(false);
  const [accountAction, setAccountAction] = useState(false);
  const [pendingLogoutId, setPendingLogoutId] = useState<string>();
  const [pendingRestart, setPendingRestart] = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodePrompt>();
  const [secondwindAction, setSecondwindAction] = useState(false);

  const refresh = useCallback(async (usage = false) => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    try {
      const [nextStatus, nextAccounts, nextDiagnostics, nextSecondwind] = await Promise.all([
        daemonControlRequest<DaemonStatus>('/v1/status'),
        daemonControlRequest<{ accounts: Account[] }>(`/v1/accounts${usage ? '?refresh=1' : ''}`, {
          timeoutMs: usage ? DASHBOARD_USAGE_REQUEST_TIMEOUT_MS : 2_000,
        }),
        daemonControlRequest<{ diagnostics: Diagnostic[] }>('/v1/diagnostics?limit=20'),
        daemonControlRequest<SecondwindSnapshot>('/v1/secondwind'),
      ]);
      const activeAccount = nextAccounts.accounts.find(account => account.selected);
      const metricsQuery = new URLSearchParams({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        bucketMinutes: String(range.bucketMinutes),
        ...(activeAccount ? { accountId: activeAccount.id } : {}),
      });
      const nextMetrics = activeAccount
        ? await daemonControlRequest<{
            start: string;
            end: string;
            accountId?: string;
            buckets: MetricBucket[];
          }>(
            `/v1/metrics?${metricsQuery.toString()}`,
          )
        : {
            start: range.start.toISOString(),
            end: range.end.toISOString(),
            buckets: [],
          };
      if (sequence !== refreshSequence.current) return;
      if (
        nextMetrics.start !== range.start.toISOString()
        || nextMetrics.end !== range.end.toISOString()
        || nextMetrics.accountId !== activeAccount?.id
      ) return;
      setStatus(nextStatus);
      setMetrics(nextMetrics.buckets);
      setAccounts(nextAccounts.accounts);
      setDiagnostics(nextDiagnostics.diagnostics);
      setSecondwind(nextSecondwind);
      const current = nextAccounts.accounts.findIndex(account => account.selected);
      if (current >= 0) setSelectedIndex(current);
      setMessage(`Updated ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      setStatus(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, [range.bucketMinutes, range.end, range.start]);

  const login = useCallback(() => {
    if (accountAction) return;
    setAccountAction(true);
    setDeviceCode(undefined);
    setMessage('Starting OpenAI sign-in…');
    loginOpenAiAccount({
      onDeviceCode: ({ url, userCode }) => {
        setDeviceCode({ url, userCode });
        setMessage('Browser opened; complete OpenAI sign-in below.');
      },
    }).then(
      account => {
        setDeviceCode(undefined);
        setMessage(`Signed in as ${account.email}`);
        void refresh(true).finally(() => setAccountAction(false));
      },
      error => {
        setDeviceCode(undefined);
        setAccountAction(false);
        setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  }, [accountAction, refresh]);

  const setSecondwindMode = useCallback((mode: SecondwindMode) => {
    if (secondwindAction || secondwind?.mode === mode) return;
    setSecondwindAction(true);
    setMessage(`Setting Secondwind ${mode}…`);
    daemonControlRequest<SecondwindSnapshot>('/v1/secondwind/mode', {
      method: 'POST',
      body: { mode },
    }).then(
      snapshot => {
        setSecondwind(snapshot);
        setMessage(`Secondwind is ${snapshot.mode}.`);
      },
      error => setMessage(error instanceof Error ? error.message : String(error)),
    ).finally(() => setSecondwindAction(false));
  }, [secondwind?.mode, secondwindAction]);

  const logout = useCallback((account: Account) => {
    if (accountAction) return;
    setAccountAction(true);
    logoutOpenAiAccount(account.id).then(
      email => {
        setPendingLogoutId(undefined);
        setMessage(`Signed out ${email}`);
        void refresh(true).finally(() => setAccountAction(false));
      },
      error => {
        setAccountAction(false);
        setPendingLogoutId(undefined);
        setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  }, [accountAction, refresh]);

  useEffect(() => {
    // Do not render the previous period's values under a newly selected label
    // while the replacement query is in flight.
    setMetrics([]);
    void refresh(true);
    const timer = setInterval(() => void refresh(), 5_000);
    const usageTimer = setInterval(() => void refresh(true), 90_000);
    return () => {
      clearInterval(timer);
      clearInterval(usageTimer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      const next = new Date();
      setRangeNow(current => {
        const currentRange = usageRange(period, periodOffset, current);
        const nextRange = usageRange(period, periodOffset, next);
        return currentRange.start.getTime() === nextRange.start.getTime()
          && currentRange.end.getTime() === nextRange.end.getTime()
          ? current
          : next;
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [period, periodOffset]);

  useInput((input, key) => {
    const selectedAccount = accounts[selectedIndex];
    const confirmsLogout = view === 'accounts'
      && input === 'x'
      && selectedAccount?.id === pendingLogoutId;
    const confirmsRestart = view === 'diagnostics'
      && input === 'R'
      && pendingRestart;
    if (pendingLogoutId && !confirmsLogout) setPendingLogoutId(undefined);
    if (pendingRestart && !confirmsRestart) setPendingRestart(false);
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    if (/^[1-5]$/.test(input)) {
      setView(VIEWS[Number(input) - 1]!);
      setPendingLogoutId(undefined);
      setPendingRestart(false);
      return;
    }
    if (input === 'r') {
      void refresh(true);
      return;
    }
    if (view === 'usage') {
      if (key.tab) {
        refreshSequence.current += 1;
        setMetrics([]);
        setPeriod(current => cyclePeriod(current, key.shift ? -1 : 1));
        setPeriodOffset(0);
        return;
      }
      if (key.leftArrow) {
        refreshSequence.current += 1;
        setMetrics([]);
        setPeriodOffset(offset => offset - 1);
        return;
      }
      if (key.rightArrow) {
        refreshSequence.current += 1;
        setMetrics([]);
        setPeriodOffset(offset => Math.min(0, offset + 1));
        return;
      }
      if (input === '0') {
        refreshSequence.current += 1;
        setMetrics([]);
        setRangeNow(new Date());
        setPeriodOffset(0);
        return;
      }
    }
    if (view === 'secondwind' && secondwind) {
      if (input === 'o') {
        setSecondwindMode('off');
        return;
      }
      if (input === 's') {
        setSecondwindMode('shadow');
        return;
      }
      if (input === 'n') {
        setSecondwindMode('on');
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const current = SECONDWIND_MODES.indexOf(secondwind.mode);
        const delta = key.leftArrow ? -1 : 1;
        const next = SECONDWIND_MODES[
          (current + delta + SECONDWIND_MODES.length) % SECONDWIND_MODES.length
        ]!;
        setSecondwindMode(next);
        return;
      }
    }
    if (view === 'accounts') {
      if (input === 'l') {
        login();
        return;
      }
      if (input === 'x' && accounts[selectedIndex]) {
        const account = accounts[selectedIndex]!;
        if (pendingLogoutId === account.id) {
          logout(account);
        } else {
          setPendingLogoutId(account.id);
          setMessage(`Press x again to log out ${accountDisplayName(account)}; any other key cancels.`);
        }
        return;
      }
      if (input === 'j' || key.downArrow) {
        setSelectedIndex(index => Math.min(accounts.length - 1, index + 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setSelectedIndex(index => Math.max(0, index - 1));
        return;
      }
      if (key.return && accounts[selectedIndex] && !accounts[selectedIndex]!.selected) {
        const account = accounts[selectedIndex]!;
        if (accountAction) return;
        setAccountAction(true);
        refreshSequence.current += 1;
        setMetrics([]);
        daemonControlRequest(`/v1/accounts/${encodeURIComponent(account.id)}/select`, {
          method: 'POST',
        }).then(
          () => {
            setPeriodOffset(0);
            return refresh(true);
          },
          error => {
            setMessage(error instanceof Error ? error.message : String(error));
          },
        ).finally(() => setAccountAction(false));
        return;
      }
    }
    if (view === 'diagnostics' && input === 'R' && status) {
      if (!pendingRestart) {
        setPendingRestart(true);
        setMessage('Press uppercase R again to restart the daemon; any other key cancels.');
        return;
      }
      setPendingRestart(false);
      daemonControlRequest('/v1/service/restart', { method: 'POST' })
        .then(() => setMessage('Restart requested; reconnecting…'))
        .catch(error => setMessage(error instanceof Error ? error.message : String(error)));
      return;
    }
  });

  const totals = useMemo(() => metrics.reduce((sum, bucket) => ({
    input: sum.input + bucket.inputTokens,
    cached: sum.cached + bucket.cachedInputTokens,
    cacheWrite: sum.cacheWrite + bucket.cacheWriteTokens,
    output: sum.output + bucket.outputTokens,
    requests: sum.requests + bucket.requests,
    errors: sum.errors + bucket.errors,
    cancellations: sum.cancellations + bucket.cancellations,
    inputCost: sum.inputCost + bucket.inputCost,
    cacheCost: sum.cacheCost + bucket.cacheCost,
    outputCost: sum.outputCost + bucket.outputCost,
    totalCost: sum.totalCost + bucket.totalCost,
    pricedRequests: sum.pricedRequests + bucket.pricedRequests,
    unpricedRequests: sum.unpricedRequests + bucket.unpricedRequests,
    standardRequests: sum.standardRequests + bucket.standardRequests,
    fastRequests: sum.fastRequests + bucket.fastRequests,
    standardCost: sum.standardCost + bucket.standardCost,
    fastCost: sum.fastCost + bucket.fastCost,
  }), {
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    errors: 0,
    cancellations: 0,
    inputCost: 0,
    cacheCost: 0,
    outputCost: 0,
    totalCost: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    standardRequests: 0,
    fastRequests: 0,
    standardCost: 0,
    fastCost: 0,
  }), [metrics]);
  const logicalInput = totals.input + totals.cached + totals.cacheWrite;
  const activeAccount = accounts.find(account => account.selected);

  if (!status) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">clodex</Text>
        <Text color="yellow">Daemon unavailable: {message}</Text>
        <Text>Run <Text bold>clodex daemon install</Text> (persistent) or <Text bold>clodex daemon run</Text> (foreground).</Text>
        <Text dimColor>r retry · q quit</Text>
      </Box>
    );
  }

  const ws = status.websocket;
  const commonHeader = (
    <>
      <Box justifyContent="space-between">
        <Text bold color="cyan">clodex</Text>
        <Text color={status.ready ? 'green' : 'yellow'}>
          {status.ready ? '● ready' : '● starting'} · pid {status.pid} · up {duration(status.uptimeSeconds)}
        </Text>
      </Box>
      <Text dimColor>endpoint {status.port}</Text>
      <ViewTabs view={view} />
    </>
  );

  let content: React.ReactNode;
  let controls: string;
  if (view === 'overview') {
    controls = `${VIEW_SWITCH_HINT} · r refresh · q quit`;
    content = (
      <>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>WebSockets and sessions</Text>
          <Text>
            {ws.total} total · {ws.inFlight} in-flight · {ws.established} established · {ws.nursery} nursery · {ws.isolated} isolated
          </Text>
          <Text dimColor>{ws.partitions} partitions · {ws.checkpoints} compact checkpoints · {status.activeSessions} active sessions</Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Active account</Text>
          {!activeAccount
            ? <Text dimColor>No managed OpenAI account.</Text>
            : (
              <>
                <Text color="cyan">● {accountDisplayName(activeAccount)}{activeAccount.plan ? ` · ${activeAccount.plan}` : ''}</Text>
                {activeAccount.usage?.primaryUsedPercent !== undefined && (
                  <UsageBar label="5-hour" used={activeAccount.usage.primaryUsedPercent} resetAt={activeAccount.usage.primaryResetAt} />
                )}
                {activeAccount.usage?.weeklyUsedPercent !== undefined && (
                  <UsageBar label="weekly" used={activeAccount.usage.weeklyUsedPercent} resetAt={activeAccount.usage.weeklyResetAt} />
                )}
                {activeAccount.usage?.stale && (
                  <Text color="yellow">usage stale{activeAccount.usage.error ? ` · ${activeAccount.usage.error}` : ''}</Text>
                )}
              </>
            )}
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Recent diagnostics</Text>
          {diagnostics.length === 0
            ? <Text dimColor>No recent failures or compaction warnings.</Text>
            : diagnostics.slice(0, 3).map((diagnostic, index) => (
                <Text key={`${diagnostic.timestamp}-${index}`} color="yellow">
                  {new Date(diagnostic.timestamp).toLocaleTimeString()} · {diagnostic.kind}
                  {diagnostic.statusCode ? ` · HTTP ${diagnostic.statusCode}` : ''}
                  {diagnostic.code ? ` · ${diagnostic.code}` : ''}
                </Text>
              ))}
        </Box>
      </>
    );
  } else if (view === 'usage') {
    controls = `Tab/Shift+Tab day·week·month · ←/→ period · 0 current · ${VIEW_SWITCH_HINT} · r refresh · q quit`;
    const tokenValues = metrics.map(bucket =>
      bucket.inputTokens
      + bucket.cachedInputTokens
      + bucket.cacheWriteTokens
      + bucket.outputTokens,
    );
    const costValues = metrics.map(bucket => bucket.totalCost);
    content = (
      <>
        <Box justifyContent="space-between">
          <Text>
            <Text bold color="cyan">{period.toUpperCase()}</Text> · {range.label}
          </Text>
          <Text>{activeAccount ? accountDisplayName(activeAccount) : 'No active account'}</Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Chart
            title="Token history"
            values={tokenValues}
            range={range}
            color="blue"
          />
          <Text>
            input {compactNumber(totals.input)} · cached {compactNumber(totals.cached)}
            {' · '}writes {compactNumber(totals.cacheWrite)} · output {compactNumber(totals.output)}
            {' · '}total {compactNumber(logicalInput + totals.output)}
          </Text>
          <Text dimColor>
            {totals.requests} requests · {totals.errors} errors · {totals.cancellations} client cancellations
            {' · '}cached share {logicalInput ? Math.round(totals.cached / logicalInput * 100) : 0}%
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Chart
            title="API-equivalent token cost"
            values={costValues}
            range={range}
            color="green"
            formatY={formatUsd}
          />
          <Text>
            input {formatUsd(totals.inputCost)} · cache {formatUsd(totals.cacheCost)}
            {' · '}output {formatUsd(totals.outputCost)} · <Text bold>total {formatUsd(totals.totalCost)}</Text>
          </Text>
          <Text>
            normal {formatUsd(totals.standardCost)} ({totals.standardRequests} req)
            {' · '}fast {formatUsd(totals.fastCost)} ({totals.fastRequests} req)
          </Text>
          <Text dimColor>
            Sol, Terra, and Luna · normal + fast processing · token-only estimate · rates as of {API_PRICING_AS_OF}
          </Text>
          <Text dimColor>
            {API_PRICING_SOURCE}
            {totals.unpricedRequests > 0 ? ` · ${totals.unpricedRequests} other-model requests excluded` : ''}
          </Text>
        </Box>
        {!activeAccount && <Text color="yellow">Select an account to view account-scoped history.</Text>}
        {activeAccount && totals.requests === 0 && (
          <Text dimColor>Account-scoped history begins when this dashboard version records new requests; legacy rows remain unattributed.</Text>
        )}
      </>
    );
  } else if (view === 'accounts') {
    controls = `↑/↓ account · Enter select · l login · x x logout · ${VIEW_SWITCH_HINT} · r refresh · q quit`;
    content = (
      <>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Accounts <Text dimColor>(manual selection; no failover)</Text></Text>
          <Text dimColor>Changes affect new Claude launches; existing sessions remain pinned.</Text>
          {accounts.length === 0
            ? <Text dimColor>No managed accounts. Press l to sign in.</Text>
            : accounts.map((account, index) => (
                <Box key={account.id} flexDirection="column">
                  <Text color={index === selectedIndex ? 'cyan' : undefined}>
                    {index === selectedIndex ? '›' : ' '} {account.selected ? '●' : '○'} {accountDisplayName(account)}
                    {account.plan ? ` · ${account.plan}` : ''}
                  </Text>
                  {account.usage && (
                    <Box paddingLeft={4} flexDirection="column">
                      {account.usage.primaryUsedPercent !== undefined && (
                        <UsageBar label="5-hour" used={account.usage.primaryUsedPercent} resetAt={account.usage.primaryResetAt} />
                      )}
                      {account.usage.weeklyUsedPercent !== undefined && (
                        <UsageBar label="weekly" used={account.usage.weeklyUsedPercent} resetAt={account.usage.weeklyResetAt} />
                      )}
                      {account.usage.stale && <Text color="yellow">usage stale{account.usage.error ? ` · ${account.usage.error}` : ''}</Text>}
                    </Box>
                  )}
                </Box>
              ))}
        </Box>
        {deviceCode && (
          <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
            <Text bold color="yellow">OpenAI sign-in</Text>
            <Text>{deviceCodeInstruction(deviceCode)}</Text>
            <Text dimColor>{deviceCode.url}</Text>
            <Text dimColor>The code stays visible until sign-in finishes.</Text>
          </Box>
        )}
      </>
    );
  } else if (view === 'diagnostics') {
    controls = `R R restart daemon · ${VIEW_SWITCH_HINT} · r refresh · q quit`;
    content = (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold>Recent diagnostics</Text>
        {diagnostics.length === 0
          ? <Text dimColor>No recent failures or compaction warnings.</Text>
          : diagnostics.map((diagnostic, index) => (
              <Text key={`${diagnostic.timestamp}-${index}`} color="yellow">
                {new Date(diagnostic.timestamp).toLocaleString()} · {diagnostic.kind}
                {diagnostic.statusCode ? ` · HTTP ${diagnostic.statusCode}` : ''}
                {diagnostic.code ? ` · ${diagnostic.code}` : ''}
              </Text>
            ))}
      </Box>
    );
  } else {
    controls = `←/→ mode · o off · s shadow · n on · ${VIEW_SWITCH_HINT} · r refresh · q quit`;
    const modeColor = secondwind?.mode === 'on'
      ? 'green'
      : secondwind?.mode === 'shadow'
        ? 'yellow'
        : undefined;
    const metricLine = (
      label: string,
      metrics: SecondwindModeMetrics | undefined,
      savingsLabel: string,
    ) => (
      <Box flexDirection="column">
        <Text bold>{label}</Text>
        <Text>
          {metrics?.requests ?? 0} requests · {metrics?.blocksRewritten ?? 0} blocks rewritten
        </Text>
        <Text>
          {secondwindTokenSummary(metrics)}
          {' · '}{secondwindPercentSaved(metrics)} of input
          {' · '}{savingsLabel} {formatUsd(metrics?.estimatedSavingsUsd ?? 0)}
        </Text>
        {(metrics?.unpricedRequests ?? 0) > 0 && (
          <Text dimColor>{metrics!.unpricedRequests} unsupported-model requests excluded from dollars</Text>
        )}
      </Box>
    );
    content = (
      <>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Secondwind tool-output optimization</Text>
          <Text>
            Daemon mode: <Text bold color={modeColor}>{secondwind?.mode ?? 'unavailable'}</Text>
            {' · '}applies to new requests immediately
          </Text>
          <Text dimColor>
            off bypasses · shadow measures and sends original · on sends losslessly rewritten tool outputs
          </Text>
          <Text dimColor>
            Mode and lifetime applied savings persist; live metrics reset with the daemon.
          </Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Lifetime applied savings</Text>
          <Text>
            {secondwindTokenSummary(secondwind?.lifetime)}
            {' · '}{secondwindPercentSaved(secondwind?.lifetime)} of input
            {' · '}estimated API-equivalent savings {formatUsd(secondwind?.lifetime?.estimatedSavingsUsd ?? 0)}
          </Text>
          <Text dimColor>
            {secondwind?.lifetime?.requests ?? 0} requests
            {' · '}{secondwind?.lifetime?.blocksRewritten ?? 0} blocks rewritten
            {' · '}tracking begins with this dashboard version
          </Text>
          <Text bold>Top sessions this daemon run</Text>
          {(secondwind?.topSessions?.length ?? 0) === 0
            ? <Text dimColor>No applied session savings yet.</Text>
            : secondwind!.topSessions!.map((session, index) => (
                <Text key={session.sessionHash}>{secondwindSessionSummary(session, index)}</Text>
              ))}
          <Text dimColor>Parent sessions include subagent and workflow traffic.</Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          {metricLine('Applied', secondwind?.applied, 'estimated savings')}
          <Text> </Text>
          {metricLine('Shadow potential', secondwind?.shadow, 'estimated possible savings')}
          <Text dimColor>API-equivalent uncached input-rate estimate for priced Sol, Terra, and Luna requests.</Text>
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Added request latency</Text>
          <Text>
            median {formatLatency(secondwind?.latency.medianMs ?? 0)}
            {' · '}p95 {formatLatency(secondwind?.latency.p95Ms ?? 0)}
            {' · '}{secondwind?.latency.samples ?? 0} samples
          </Text>
          <Text dimColor>
            {secondwind?.sessions ?? 0} conversation sessions · {secondwind?.errors ?? 0} fail-open errors
            {secondwind?.loaded ? ' · native optimizer loaded' : ' · optimizer not loaded'}
          </Text>
          {secondwind?.lastError && <Text color="yellow">Last error: {secondwind.lastError}</Text>}
        </Box>
      </>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {commonHeader}
      {content}
      <Text dimColor>
        {controls}
        {' · '}{message}
        {accountAction
          ? ' · account action in progress…'
          : secondwindAction
            ? ' · saving Secondwind mode…'
            : loading
              ? ' · refreshing…'
              : ''}
      </Text>
    </Box>
  );
}

export async function runDashboard(): Promise<number> {
  const instance = render(<Dashboard />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
  return 0;
}
