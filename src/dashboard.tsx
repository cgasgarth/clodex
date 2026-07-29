import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { daemonControlRequest } from './daemon/control-client.js';
import { DASHBOARD_USAGE_REQUEST_TIMEOUT_MS } from './daemon/timeouts.js';
import {
  loginOpenAiAccount,
  logoutOpenAiAccount,
} from './daemon/account-command.js';

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
  proxyPort: number;
  endpointPort: number;
  websocket: WebSocketStatus;
  activeSessions: number;
  sessions: SessionStatus[];
}

interface MetricBucket {
  timestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  requests: number;
  errors: number;
  cancellations: number;
  durationMs: number;
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

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

export function accountDisplayName(account: Pick<Account, 'email'>): string {
  return account.email ?? 'Email unavailable';
}

export function deviceCodeInstruction({ userCode }: DeviceCodePrompt): string {
  return `Enter code ${userCode} in the browser.`;
}

export function sparkline(values: number[], width = 48): string {
  if (values.length === 0) return '·'.repeat(width);
  const sampled = values.length <= width
    ? values
    : Array.from({ length: width }, (_, index) => {
        const start = Math.floor(index * values.length / width);
        const end = Math.max(start + 1, Math.floor((index + 1) * values.length / width));
        return values.slice(start, end).reduce((sum, value) => sum + value, 0);
      });
  const max = Math.max(1, ...sampled);
  return sampled
    .map(value => value === 0
      ? '·'
      : SPARK_CHARS[Math.min(
          SPARK_CHARS.length - 1,
          Math.floor(value / max * SPARK_CHARS.length),
        )])
    .join('')
    .padEnd(width, '·');
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
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

function Dashboard(): React.ReactNode {
  const { exit } = useApp();
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [metrics, setMetrics] = useState<MetricBucket[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState('Connecting to Clodex daemon…');
  const [loading, setLoading] = useState(false);
  const [accountAction, setAccountAction] = useState(false);
  const [pendingLogoutId, setPendingLogoutId] = useState<string>();
  const [deviceCode, setDeviceCode] = useState<DeviceCodePrompt>();

  const refresh = useCallback(async (usage = false) => {
    setLoading(true);
    try {
      const [nextStatus, nextMetrics, nextAccounts, nextDiagnostics] = await Promise.all([
        daemonControlRequest<DaemonStatus>('/v1/status'),
        daemonControlRequest<{ buckets: MetricBucket[] }>('/v1/metrics?hours=24&bucketMinutes=5'),
        daemonControlRequest<{ accounts: Account[] }>(`/v1/accounts${usage ? '?refresh=1' : ''}`, {
          timeoutMs: usage ? DASHBOARD_USAGE_REQUEST_TIMEOUT_MS : 2_000,
        }),
        daemonControlRequest<{ diagnostics: Diagnostic[] }>('/v1/diagnostics?limit=8'),
      ]);
      setStatus(nextStatus);
      setMetrics(nextMetrics.buckets);
      setAccounts(nextAccounts.accounts);
      setDiagnostics(nextDiagnostics.diagnostics);
      const current = nextAccounts.accounts.findIndex(account => account.selected);
      if (current >= 0) setSelectedIndex(current);
      setMessage(`Updated ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      setStatus(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
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
        void refresh(true).finally(() => setAccountAction(false));
      },
      error => {
        setDeviceCode(undefined);
        setAccountAction(false);
        setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  }, [accountAction, refresh]);

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
    void refresh(true);
    const timer = setInterval(() => void refresh(), 5_000);
    const usageTimer = setInterval(() => void refresh(true), 90_000);
    return () => {
      clearInterval(timer);
      clearInterval(usageTimer);
    };
  }, [refresh]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
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
    if (pendingLogoutId) setPendingLogoutId(undefined);
    if (input === 'r') void refresh(true);
    if (input === 'j' || key.downArrow) {
      setSelectedIndex(index => Math.min(accounts.length - 1, index + 1));
    }
    if (input === 'k' || key.upArrow) {
      setSelectedIndex(index => Math.max(0, index - 1));
    }
    if (key.return && accounts[selectedIndex] && !accounts[selectedIndex]!.selected) {
      const account = accounts[selectedIndex]!;
      if (accountAction) return;
      setAccountAction(true);
      daemonControlRequest(`/v1/accounts/${encodeURIComponent(account.id)}/select`, {
        method: 'POST',
      }).then(
        () => refresh(true).finally(() => setAccountAction(false)),
        error => {
        setAccountAction(false);
        setMessage(error instanceof Error ? error.message : String(error));
        },
      );
    }
    if (input === 's' && status) {
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
  }), {
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    errors: 0,
    cancellations: 0,
  }), [metrics]);
  const logicalInput = totals.input + totals.cached + totals.cacheWrite;

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
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">clodex</Text>
        <Text color={status.ready ? 'green' : 'yellow'}>
          {status.ready ? '● ready' : '● starting'} · pid {status.pid} · up {duration(status.uptimeSeconds)}
        </Text>
      </Box>
      <Text dimColor>endpoint {status.endpointPort} · selective proxy {status.proxyPort}</Text>

      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold>WebSockets</Text>
        <Text>
          {ws.total} total · {ws.inFlight} in-flight · {ws.established} established · {ws.nursery} nursery · {ws.isolated} isolated
        </Text>
        <Text dimColor>{ws.partitions} partitions · {ws.checkpoints} compact checkpoints · {status.activeSessions} active sessions</Text>
      </Box>

      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold>24-hour tokens</Text>
        <Text color="blue">input  {sparkline(metrics.map(bucket => bucket.inputTokens))} {compactNumber(totals.input)}</Text>
        <Text color="green">cached {sparkline(metrics.map(bucket => bucket.cachedInputTokens))} {compactNumber(totals.cached)}</Text>
        <Text color="yellow">writes {sparkline(metrics.map(bucket => bucket.cacheWriteTokens))} {compactNumber(totals.cacheWrite)}</Text>
        <Text color="magenta">output {sparkline(metrics.map(bucket => bucket.outputTokens))} {compactNumber(totals.output)}</Text>
        <Text dimColor>
          {totals.requests} requests · {totals.errors} errors · {totals.cancellations} client cancellations
          {' · '}cached share {logicalInput ? Math.round(totals.cached / logicalInput * 100) : 0}%
        </Text>
      </Box>

      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold>Accounts <Text dimColor>(manual selection; no failover)</Text></Text>
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

      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold>Recent diagnostics</Text>
        {diagnostics.length === 0
          ? <Text dimColor>No recent failures or compaction warnings.</Text>
          : diagnostics.slice(0, 5).map((diagnostic, index) => (
              <Text key={`${diagnostic.timestamp}-${index}`} color="yellow">
                {new Date(diagnostic.timestamp).toLocaleTimeString()} · {diagnostic.kind}
                {diagnostic.statusCode ? ` · HTTP ${diagnostic.statusCode}` : ''}
                {diagnostic.code ? ` · ${diagnostic.code}` : ''}
              </Text>
            ))}
      </Box>

      <Text dimColor>
        ↑/↓ account · Enter select · l login · x logout · r refresh · s restart · q quit
        {' · '}{message}
        {accountAction ? ' · account action in progress…' : loading ? ' · refreshing…' : ''}
      </Text>
    </Box>
  );
}

export async function runDashboard(): Promise<number> {
  const instance = render(<Dashboard />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
  return 0;
}
