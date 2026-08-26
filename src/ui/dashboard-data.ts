import { isNumber, isString } from '../runtime/type-guards.js';
import type { DiagnosticRecord } from '../observability/trace-log.js';
import {
  daemonControlRequest,
  type DaemonControlRequestOptions,
} from '../daemon/control-client.js';
import type {
  SecondwindModeMetrics,
  SecondwindSessionSavings,
  SecondwindSnapshot,
} from '../daemon/secondwind.js';
import { DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS } from '../config/timeouts.js';
import type { DiagnosticLogMode } from '../types.js';

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

export interface DaemonStatus {
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

export interface Account {
  id: string;
  providerId: 'openai-oauth' | 'xai-oauth';
  name?: string;
  email?: string;
  selected: boolean;
  plan?: string;
  usage?: {
    primaryUsedPercent?: number;
    primaryResetAt?: number;
    weeklyUsedPercent?: number;
    weeklyResetAt?: number;
    limitUsedPercent?: number;
    limitResetAt?: number;
    limitPeriod?: 'weekly' | 'monthly' | 'usage';
    usedCents?: number;
    limitCents?: number;
    onDemandUsedCents?: number;
    onDemandLimitCents?: number;
    prepaidBalanceCents?: number;
    stale?: boolean;
    error?: string;
  };
}

export interface Diagnostic {
  timestamp: string;
  kind: string;
  requestId?: string;
  sessionId?: string;
  sessionHash?: string;
  threadName?: string;
  code?: string;
  statusCode?: number;
  detail?: DiagnosticRecord;
}

export interface DeviceCodePrompt {
  url: string;
  userCode: string;
}

export type UsagePeriod = 'day' | 'last7' | 'last30';
export type UsageAccountScope = 'active' | 'all';

export interface UsageRange {
  period: UsagePeriod;
  offset: number;
  start: Date;
  end: Date;
  label: string;
  bucketMinutes: number;
}

export type DashboardRequest = <T>(
  path: string,
  options?: DaemonControlRequestOptions,
) => Promise<T>;

export interface DashboardPanelSnapshot {
  reachable: boolean;
  status?: DaemonStatus;
  accounts?: Account[];
  diagnostics?: Diagnostic[];
  diagnosticLogMode?: DiagnosticLogMode;
  secondwind?: SecondwindSnapshot;
  warnings: string[];
}

const PERIODS: UsagePeriod[] = ['day', 'last7', 'last30'];
const CHART_WIDTH = 56;
const CHART_HEIGHT = 6;
export const VIEW_SWITCH_HINT = 'Press 1–5 to switch views';

export function requestFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function loadDashboardPanels(
  request: DashboardRequest = daemonControlRequest,
): Promise<DashboardPanelSnapshot> {
  const options = { timeoutMs: DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS };
  const [status, accounts, diagnostics, secondwind] = await Promise.allSettled([
    request<DaemonStatus>('/v1/status', options),
    request<{ accounts: Account[] }>('/v1/accounts', options),
    request<{ diagnostics: Diagnostic[]; mode: DiagnosticLogMode }>(
      '/v1/diagnostics?limit=20',
      options,
    ),
    request<SecondwindSnapshot>('/v1/secondwind', options),
  ]);
  const warnings: string[] = [];
  if (status.status === 'rejected') warnings.push(`status: ${requestFailure(status.reason)}`);
  if (accounts.status === 'rejected') warnings.push(`accounts: ${requestFailure(accounts.reason)}`);
  if (diagnostics.status === 'rejected') {
    warnings.push(`diagnostics: ${requestFailure(diagnostics.reason)}`);
  }
  if (secondwind.status === 'rejected') {
    warnings.push(`Secondwind: ${requestFailure(secondwind.reason)}`);
  }
  let reachable = [status, accounts, diagnostics, secondwind]
    .some(result => result.status === 'fulfilled');
  if (!reachable) {
    try {
      await request('/v1/health', options);
      reachable = true;
    } catch (error) {
      warnings.push(`health: ${requestFailure(error)}`);
    }
  }

  return {
    reachable,
    status: status.status === 'fulfilled' ? status.value : undefined,
    accounts: accounts.status === 'fulfilled' ? accounts.value.accounts : undefined,
    diagnostics: diagnostics.status === 'fulfilled'
      ? diagnostics.value.diagnostics
      : undefined,
    diagnosticLogMode: diagnostics.status === 'fulfilled'
      ? diagnostics.value.mode
      : undefined,
    secondwind: secondwind.status === 'fulfilled' ? secondwind.value : undefined,
    warnings,
  };
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function diagnosticNumber(detail: DiagnosticRecord | undefined, key: string): number | undefined {
  const value = detail?.[key];
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function diagnosticText(detail: DiagnosticRecord | undefined, key: string): string | undefined {
  const value = detail?.[key];
  return isString(value) && value ? value : undefined;
}

function compactionInput(detail: DiagnosticRecord | undefined): number | undefined {
  return diagnosticNumber(detail, 'inputTokens')
    ?? diagnosticNumber(detail, 'estimatedPrefixTokens')
    ?? diagnosticNumber(detail, 'canonicalEstimatedInputTokens')
    ?? diagnosticNumber(detail, 'measuredInputTokens')
    ?? diagnosticNumber(detail, 'estimatedInputTokens');
}

export function diagnosticLines(diagnostic: Diagnostic): string[] {
  const detail = diagnostic.detail;
  const outcome = diagnosticText(detail, 'outcome');
  const stage = diagnosticNumber(detail, 'stage');
  const lifecycle = diagnostic.kind === 'ws_compaction'
    ? `compaction ${outcome ?? 'event'}${stage ? ` · stage ${stage}` : ''}`
    : diagnostic.kind;
  const header = `${new Date(diagnostic.timestamp).toLocaleString()} · ${lifecycle}`
    + (diagnostic.statusCode ? ` · HTTP ${diagnostic.statusCode}` : '')
    + (diagnostic.code ? ` · ${diagnostic.code}` : '');
  const lines = [header];
  if (diagnostic.threadName || diagnostic.sessionId) {
    lines.push(`thread ${diagnostic.threadName ?? 'untitled'} · ${diagnostic.sessionId ?? diagnostic.sessionHash}`);
  }
  if (diagnostic.kind !== 'ws_compaction') return lines;

  const input = compactionInput(detail);
  const output = diagnosticNumber(detail, 'outputTokens');
  const result = diagnosticNumber(detail, 'estimatedRebasedTokens');
  const raw = diagnosticNumber(detail, 'estimatedInputTokens');
  const sizes = [
    input === undefined ? undefined : `input ${compactNumber(input)}`,
    output === undefined ? undefined : `compact output ${compactNumber(output)}`,
    result === undefined ? undefined : `resulting context ${compactNumber(result)}`,
    raw !== undefined && raw !== input ? `raw transcript ${compactNumber(raw)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (sizes.length) lines.push(sizes.join(' · '));
  const durationMs = diagnosticNumber(detail, 'durationMs');
  const transport = diagnosticText(detail, 'transport');
  const reason = diagnosticText(detail, 'reason');
  const context = [
    durationMs === undefined ? undefined : `duration ${formatDiagnosticDuration(durationMs)}`,
    transport,
    reason,
  ].filter((value): value is string => Boolean(value));
  if (context.length) lines.push(context.join(' · '));
  return lines;
}

function formatDiagnosticDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

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
    + ` (${secondwindPercentSaved(session)} of tool output saved)`
    + ` · ${formatUsd(session.estimatedSavingsUsd)} estimated savings`
    + ` · ${session.requests} req`;
}

export function accountDisplayName(account: Pick<Account, 'email' | 'name'>): string {
  return account.email ?? account.name ?? 'Account identity unavailable';
}

export function deviceCodeInstruction({ userCode }: DeviceCodePrompt): string {
  return `Enter code ${userCode} in the browser.`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function usageRange(
  period: UsagePeriod,
  offset = 0,
  now = new Date(),
): UsageRange {
  if (period === 'day') {
    const start = startOfDay(now);
    start.setDate(start.getDate() + offset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const label = start.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return { period, offset, start, end, label, bucketMinutes: 60 };
  }
  const windowDays = period === 'last7' ? 7 : 30;
  const end = startOfDay(now);
  end.setDate(end.getDate() + 1 + offset * windowDays);
  const start = new Date(end);
  start.setDate(start.getDate() - windowDays);
  const inclusiveEnd = new Date(end);
  inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
  const label = `${start.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} – ${inclusiveEnd.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
  return { period, offset, start, end, label, bucketMinutes: 60 };
}

export function usagePeriodLabel(period: UsagePeriod): string {
  if (period === 'last7') return 'LAST 7 DAYS';
  if (period === 'last30') return 'LAST 30 DAYS';
  return 'DAY';
}

export function usageMetricsPath(
  range: UsageRange,
  scope: UsageAccountScope,
  activeAccountId?: string,
): string | undefined {
  const query = new URLSearchParams({
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    bucketMinutes: String(range.bucketMinutes),
  });
  if (scope === 'active') {
    if (!activeAccountId) return undefined;
    query.set('accountId', activeAccountId);
  }
  return `/v1/metrics?${query.toString()}`;
}

export async function loadUsageMetrics(
  range: UsageRange,
  scope: UsageAccountScope,
  activeAccountId?: string,
  request: DashboardRequest = daemonControlRequest,
): Promise<MetricBucket[]> {
  const path = usageMetricsPath(range, scope, activeAccountId);
  if (!path) return [];
  const result = await request<{
    start: string;
    end: string;
    accountId?: string;
    buckets: MetricBucket[];
  }>(path, { timeoutMs: DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS });
  const expectedAccountId = scope === 'active' ? activeAccountId : undefined;
  if (
    result.start !== range.start.toISOString()
    || result.end !== range.end.toISOString()
    || result.accountId !== expectedAccountId
  ) {
    throw new Error('Usage metrics response does not match the requested range or account scope');
  }
  return result.buckets;
}

export function cyclePeriod(period: UsagePeriod, direction: 1 | -1): UsagePeriod {
  const index = PERIODS.indexOf(period);
  return PERIODS[(index + direction + PERIODS.length) % PERIODS.length]!;
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
  const leftGap = Math.max(
    1,
    Math.floor((innerWidth - startLabel.length - middleLabel.length - endLabel.length) / 2),
  );
  const rightGap = Math.max(
    1,
    innerWidth - startLabel.length - middleLabel.length - endLabel.length - leftGap,
  );
  lines.push(
    `${' '.repeat(yLabelWidth + 2)}${startLabel}${' '.repeat(leftGap)}${middleLabel}${' '.repeat(rightGap)}${endLabel}`,
  );
  return lines;
}
