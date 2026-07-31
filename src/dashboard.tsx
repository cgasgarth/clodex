import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { daemonControlRequest } from './daemon/control-client.js';
import {
  DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS,
  DASHBOARD_USAGE_REQUEST_TIMEOUT_MS,
} from './timeouts.js';
import {
  loginOpenAiAccount,
  logoutOpenAiAccount,
} from './daemon/account-command.js';
import {
  API_PRICING_AS_OF,
  API_PRICING_SOURCE,
} from './daemon/api-pricing.js';
import type { SecondwindModeMetrics, SecondwindSnapshot } from './daemon/secondwind.js';
import type { SecondwindMode } from './types.js';
import type { DaemonClaudeModelSnapshot, DaemonClaudeModelView } from './daemon/model-service.js';
import {
  accountDisplayName,
  compactNumber,
  cyclePeriod,
  deviceCodeInstruction,
  formatUsd,
  lineChart,
  loadDashboardPanels,
  requestFailure,
  secondwindPercentSaved,
  secondwindSessionSummary,
  secondwindTokenSummary,
  usageRange,
  VIEW_SWITCH_HINT,
  type Account,
  type DaemonStatus,
  type DeviceCodePrompt,
  type Diagnostic,
  type MetricBucket,
  type UsagePeriod,
  type UsageRange,
} from './dashboard-data.js';
type DashboardView =
  | 'overview'
  | 'usage'
  | 'accounts'
  | 'diagnostics'
  | 'secondwind'
  | 'models';

const VIEWS: DashboardView[] = [
  'overview',
  'usage',
  'accounts',
  'diagnostics',
  'secondwind',
  'models',
];
const SECONDWIND_MODES: SecondwindMode[] = ['off', 'shadow', 'on'];

function formatLatency(value: number): string {
  if (value < 1) return `${value.toFixed(2)}ms`;
  if (value < 100) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
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
  const usageRefreshSequence = useRef(0);
  const refreshInFlight = useRef(false);
  const usageRefreshInFlight = useRef(false);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [daemonReachable, setDaemonReachable] = useState<boolean | null>(null);
  const [metrics, setMetrics] = useState<MetricBucket[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [secondwind, setSecondwind] = useState<SecondwindSnapshot | null>(null);
  const [models, setModels] = useState<DaemonClaudeModelView[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [message, setMessage] = useState('Connecting to Clodex daemon…');
  const [loading, setLoading] = useState(false);
  const [accountAction, setAccountAction] = useState(false);
  const [pendingLogoutId, setPendingLogoutId] = useState<string>();
  const [pendingRestart, setPendingRestart] = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodePrompt>();
  const [secondwindAction, setSecondwindAction] = useState(false);
  const [pendingSecondwindMode, setPendingSecondwindMode] = useState<SecondwindMode>();
  const [modelAction, setModelAction] = useState(false);
  const [pendingModelChange, setPendingModelChange] = useState<{
    modelId: string;
    name: string;
    enabled: boolean;
  }>();

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    try {
      const snapshot = await loadDashboardPanels();
      if (sequence !== refreshSequence.current) return;
      setDaemonReachable(snapshot.reachable);
      if (snapshot.status) setStatus(snapshot.status);
      else if (!snapshot.reachable) setStatus(null);
      if (snapshot.accounts) {
        setAccounts(snapshot.accounts);
        const current = snapshot.accounts.findIndex(account => account.selected);
        if (current >= 0) setSelectedIndex(current);
      }
      if (snapshot.diagnostics) setDiagnostics(snapshot.diagnostics);
      if (snapshot.secondwind) setSecondwind(snapshot.secondwind);
      if (snapshot.models) {
        setModels(snapshot.models);
        setSelectedModelIndex(index => Math.min(index, Math.max(0, snapshot.models!.length - 1)));
      }

      const warnings = [...snapshot.warnings];
      const activeAccount = snapshot.accounts?.find(account => account.selected);
      const metricsQuery = new URLSearchParams({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        bucketMinutes: String(range.bucketMinutes),
        ...(activeAccount ? { accountId: activeAccount.id } : {}),
      });
      if (activeAccount) {
        try {
          const nextMetrics = await daemonControlRequest<{
            start: string;
            end: string;
            accountId?: string;
            buckets: MetricBucket[];
          }>(
            `/v1/metrics?${metricsQuery.toString()}`,
            { timeoutMs: DASHBOARD_CONTROL_REQUEST_TIMEOUT_MS },
          );
          if (sequence !== refreshSequence.current) return;
          if (
            nextMetrics.start === range.start.toISOString()
            && nextMetrics.end === range.end.toISOString()
            && nextMetrics.accountId === activeAccount.id
          ) {
            setMetrics(nextMetrics.buckets);
          }
        } catch (error) {
          warnings.push(`metrics: ${requestFailure(error)}`);
        }
      } else if (snapshot.accounts) {
        setMetrics([]);
      }
      if (sequence !== refreshSequence.current) return;
      setMessage(warnings.length > 0
        ? `Updated with warnings · ${warnings.join(' · ')}`
        : `Updated ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  }, [range.bucketMinutes, range.end, range.start]);

  const refreshUsage = useCallback(async () => {
    if (usageRefreshInFlight.current) return;
    usageRefreshInFlight.current = true;
    const sequence = ++usageRefreshSequence.current;
    try {
      const nextAccounts = await daemonControlRequest<{ accounts: Account[] }>(
        '/v1/accounts?refresh=1',
        { timeoutMs: DASHBOARD_USAGE_REQUEST_TIMEOUT_MS },
      );
      if (sequence !== usageRefreshSequence.current) return;
      setAccounts(nextAccounts.accounts);
      const current = nextAccounts.accounts.findIndex(account => account.selected);
      if (current >= 0) setSelectedIndex(current);
    } catch (error) {
      if (sequence !== usageRefreshSequence.current) return;
      setMessage(`Account usage refresh failed · ${requestFailure(error)}`);
    } finally {
      usageRefreshInFlight.current = false;
    }
  }, []);

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
        void Promise.allSettled([refresh(), refreshUsage()])
          .finally(() => setAccountAction(false));
      },
      error => {
        setDeviceCode(undefined);
        setAccountAction(false);
        setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  }, [accountAction, refresh, refreshUsage]);

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

  const setClaudeModelEnabled = useCallback((
    modelId: string,
    enabled: boolean,
  ) => {
    if (modelAction) return;
    setModelAction(true);
    setMessage(`${enabled ? 'Enabling' : 'Disabling'} ${modelId}…`);
    daemonControlRequest<DaemonClaudeModelSnapshot>('/v1/claude/models', {
      method: 'POST',
      body: { modelId, enabled },
    }).then(
      snapshot => {
        setModels(snapshot.models);
        setMessage(
          `${modelId} ${enabled ? 'enabled' : 'disabled'}; `
          + 'the live route catalog and new Claude launches are updated.',
        );
      },
      error => setMessage(error instanceof Error ? error.message : String(error)),
    ).finally(() => setModelAction(false));
  }, [modelAction]);

  const logout = useCallback((account: Account) => {
    if (accountAction) return;
    setAccountAction(true);
    logoutOpenAiAccount(account.id).then(
      email => {
        setPendingLogoutId(undefined);
        setMessage(`Signed out ${email}`);
        void Promise.allSettled([refresh(), refreshUsage()])
          .finally(() => setAccountAction(false));
      },
      error => {
        setAccountAction(false);
        setPendingLogoutId(undefined);
        setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  }, [accountAction, refresh, refreshUsage]);

  useEffect(() => {
    // Do not render the previous period's values under a newly selected label
    // while the replacement query is in flight.
    setMetrics([]);
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void refreshUsage();
    const timer = setInterval(() => void refreshUsage(), 90_000);
    return () => clearInterval(timer);
  }, [refreshUsage]);

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

    if (pendingSecondwindMode) {
      if (key.return) {
        const mode = pendingSecondwindMode;
        setPendingSecondwindMode(undefined);
        setSecondwindMode(mode);
      } else {
        setPendingSecondwindMode(undefined);
        setMessage('Secondwind mode change cancelled.');
      }
      return;
    }
    if (pendingModelChange) {
      if (key.return) {
        const change = pendingModelChange;
        setPendingModelChange(undefined);
        setClaudeModelEnabled(change.modelId, change.enabled);
      } else {
        setPendingModelChange(undefined);
        setMessage('Claude model change cancelled.');
      }
      return;
    }
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    if (/^[1-6]$/.test(input)) {
      setView(VIEWS[Number(input) - 1]!);
      setPendingLogoutId(undefined);
      setPendingRestart(false);
      setPendingSecondwindMode(undefined);
      setPendingModelChange(undefined);
      return;
    }
    if (input === 'r') {
      void refresh();
      void refreshUsage();
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
      if (secondwindAction) return;
      if (input === 'o') {
        if (secondwind.mode !== 'off') setPendingSecondwindMode('off');
        return;
      }
      if (input === 's') {
        if (secondwind.mode !== 'shadow') setPendingSecondwindMode('shadow');
        return;
      }
      if (input === 'n') {
        if (secondwind.mode !== 'on') setPendingSecondwindMode('on');
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const current = SECONDWIND_MODES.indexOf(secondwind.mode);
        const delta = key.leftArrow ? -1 : 1;
        const next = SECONDWIND_MODES[
          (current + delta + SECONDWIND_MODES.length) % SECONDWIND_MODES.length
        ]!;
        if (next !== secondwind.mode) setPendingSecondwindMode(next);
        return;
      }
    }
    if (view === 'models') {
      if (modelAction) return;
      if (input === 'j' || key.downArrow) {
        setSelectedModelIndex(index => Math.min(Math.max(0, models.length - 1), index + 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setSelectedModelIndex(index => Math.max(0, index - 1));
        return;
      }
      if (input === ' ' && models[selectedModelIndex]) {
        const model = models[selectedModelIndex];
        setPendingModelChange({
          modelId: model.modelId,
          name: model.alias ?? model.name,
          enabled: !model.enabled,
        });
        setMessage(
          `Press Enter to ${model.enabled ? 'disable' : 'enable'} `
          + `${model.alias ?? model.name}; any other key cancels.`,
        );
        return;
      }
    }
    if (view === 'accounts') {
      if (input === 'l') {
        login();
        return;
      }
      if (input === 'x' && accounts[selectedIndex]) {
        const account = accounts[selectedIndex];
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
      if (key.return && accounts[selectedIndex] && !accounts[selectedIndex].selected) {
        const account = accounts[selectedIndex];
        if (accountAction) return;
        setAccountAction(true);
        refreshSequence.current += 1;
        setMetrics([]);
        daemonControlRequest(`/v1/accounts/${encodeURIComponent(account.id)}/select`, {
          method: 'POST',
        }).then(
          () => {
            setPeriodOffset(0);
            return Promise.allSettled([refresh(), refreshUsage()]);
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

  if (daemonReachable === false) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">clodex</Text>
        <Text color="yellow">Daemon unavailable: {message}</Text>
        <Text>Run <Text bold>clodex daemon install</Text> (persistent) or <Text bold>clodex daemon run</Text> (foreground).</Text>
        <Text dimColor>r retry · q quit</Text>
      </Box>
    );
  }

  if (!status) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">clodex</Text>
        <Text color={daemonReachable ? 'yellow' : undefined}>
          {daemonReachable
            ? `Daemon reachable; status panel delayed · ${message}`
            : message}
        </Text>
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
  } else if (view === 'secondwind') {
    controls = `←/→ choose · o off · s shadow · n on · Enter confirm · ${VIEW_SWITCH_HINT} · r refresh · q quit`;
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
          {' · '}{secondwindPercentSaved(metrics)} of tool-output tokens saved
          {' · '}{savingsLabel} {formatUsd(metrics?.estimatedSavingsUsd ?? 0)}
        </Text>
        {((metrics?.savedInputTokens ?? 0)
          + (metrics?.savedCachedInputTokens ?? 0)
          + (metrics?.savedCacheWriteTokens ?? 0)) > 0 && (
          <Text dimColor>
            saved attribution: {compactNumber(metrics?.savedInputTokens ?? 0)} uncached
            {' / '}{compactNumber(metrics?.savedCachedInputTokens ?? 0)} cache reads
            {' / '}{compactNumber(metrics?.savedCacheWriteTokens ?? 0)} cache writes
          </Text>
        )}
        {((metrics?.estimatedInputSavingsUsd ?? 0)
          + (metrics?.estimatedCacheSavingsUsd ?? 0)
          + (metrics?.estimatedOutputSavingsUsd ?? 0)) > 0 && (
          <Text dimColor>
            estimated dollars: {formatUsd(metrics?.estimatedInputSavingsUsd ?? 0)} input
            {' + '}{formatUsd(metrics?.estimatedCacheSavingsUsd ?? 0)} cache
            {' + '}{formatUsd(metrics?.estimatedOutputSavingsUsd ?? 0)} output threshold
          </Text>
        )}
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
        {pendingSecondwindMode && (
          <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
            <Text bold color="yellow">Confirm Secondwind mode change</Text>
            <Text>
              Change <Text bold>{secondwind?.mode}</Text> → <Text bold>{pendingSecondwindMode}</Text>?
            </Text>
            <Text dimColor>Press Enter to confirm; any other key cancels.</Text>
          </Box>
        )}
        {secondwind && (
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Lifetime applied savings</Text>
          <Text>
            {secondwindTokenSummary(secondwind.lifetime)}
            {' · '}{secondwindPercentSaved(secondwind.lifetime)} of tool-output tokens saved
            {' · '}estimated API-equivalent savings {formatUsd(secondwind.lifetime.estimatedSavingsUsd)}
          </Text>
          <Text dimColor>
            {secondwind.lifetime.requests} requests
            {' · '}{secondwind.lifetime.blocksRewritten} blocks rewritten
            {' · '}tracking begins with this dashboard version
          </Text>
          {(secondwind.lifetime.savedInputTokens
            + secondwind.lifetime.savedCachedInputTokens
            + secondwind.lifetime.savedCacheWriteTokens) > 0
            ? (
                <Text dimColor>
                  Cache-aware savings attribution is available for this portion.
                </Text>
              )
            : secondwind.lifetime.estimatedSavingsUsd > 0 && (
                <Text dimColor>
                  Historical total predates cache-attribution tracking.
                </Text>
              )}
          <Text bold>Top sessions this daemon run</Text>
          {secondwind.topSessions.length === 0
            ? <Text dimColor>No applied session savings yet.</Text>
            : secondwind.topSessions.map((session, index) => (
                <Text key={session.sessionHash}>{secondwindSessionSummary(session, index)}</Text>
              ))}
          <Text dimColor>Parent sessions include subagent and workflow traffic.</Text>
        </Box>
        )}
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          {metricLine('Applied', secondwind?.applied, 'estimated savings')}
          <Text> </Text>
          {metricLine('Shadow potential', secondwind?.shadow, 'estimated possible savings')}
          <Text dimColor>API-equivalent cache-aware estimate for priced Sol, Terra, and Luna requests.</Text>
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
  } else {
    controls = `↑/↓ model · Space toggle · Enter confirm · ${VIEW_SWITCH_HINT} · r refresh · q quit`;
    content = (
      <>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text bold>Claude OpenAI model list</Text>
          <Text dimColor>
            Routes change immediately; the patched picker changes for new Claude launches.
          </Text>
          {models.length === 0
            ? <Text dimColor>No OpenAI models are available in the provider registry.</Text>
            : models.map((model, index) => (
                <Text
                  key={model.modelId}
                  color={index === selectedModelIndex ? 'cyan' : undefined}
                >
                  {index === selectedModelIndex ? '›' : ' '}
                  {' '}{model.enabled ? '●' : '○'}
                  {' '}{model.alias ? `${model.alias} · ` : ''}{model.name}
                  {' · '}{model.modelId}
                  {model.contextWindow ? ` · ${compactNumber(model.contextWindow)} context` : ''}
                </Text>
              ))}
        </Box>
        {pendingModelChange && (
          <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
            <Text bold color="yellow">Confirm Claude model change</Text>
            <Text>
              {pendingModelChange.enabled ? 'Enable' : 'Disable'}{' '}
              <Text bold>{pendingModelChange.name}</Text>?
            </Text>
            <Text dimColor>
              This updates the live route catalog and repatches Claude. Press Enter to confirm;
              {' '}any other key cancels.
            </Text>
          </Box>
        )}
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
            : modelAction
              ? ' · updating Claude model list…'
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
