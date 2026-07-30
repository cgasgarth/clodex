import pc from 'picocolors';
import { spawn } from 'node:child_process';
import {
  getDaemonControlSocketPath,
  getDaemonLaunchAgentPath,
  getLogsPath,
} from '../paths.js';
import { VERSION } from '../constants.js';
import {
  loadHttpProxyRoutes,
  startConfiguredHttpProxy,
} from '../http-proxy/index.js';
import { startProxyCatalog, type ProxyHandle } from '../proxy.js';
import {
  isPidAlive,
  registerServerRuntimeState,
  unregisterServerRuntimeState,
} from '../server-runtime.js';
import {
  getInferenceRequestLogPath,
  getSessionLogPath,
  subscribeInferenceTrace,
  writeProxyLifecycleLog,
} from '../trace-log.js';
import { DaemonInferenceCollector } from './collector.js';
import { startDaemonControlApi } from './control-api.js';
import { daemonControlRequest } from './control-client.js';
import {
  createDaemonRuntimeState,
  type DaemonRuntimeState,
  readDaemonRuntimeState,
  removeDaemonRuntimeState,
  writeDaemonRuntimeState,
} from './runtime.js';
import {
  installDaemonLaunchAgent,
  uninstallDaemonLaunchAgent,
} from './launch-agent.js';
import { createDaemonAccountController } from './account-service.js';
import { createDaemonSecondwindService } from './secondwind.js';

interface DaemonStatusResponse {
  running: boolean;
  ready: boolean;
  version: string;
  pid: number;
  uptimeSeconds: number;
  proxyPort: number;
  endpointPort: number;
  activeSessions: number;
  websocket: {
    total: number;
    inFlight: number;
    established: number;
    nursery: number;
    isolated: number;
  };
}

interface DaemonHealthResponse {
  ok: boolean;
  protocolVersion: number;
  instanceId: string;
  version: string;
}

export const DEFAULT_DAEMON_PORT = 17646;
export const DEFAULT_DAEMON_ENDPOINT_PORT = 17647;

export function resolveDaemonPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['CLODEX_DAEMON_PORT']?.trim();
  if (!raw) return DEFAULT_DAEMON_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CLODEX_DAEMON_PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function resolveDaemonEndpointPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['CLODEX_DAEMON_ENDPOINT_PORT']?.trim();
  if (!raw) return DEFAULT_DAEMON_ENDPOINT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CLODEX_DAEMON_ENDPOINT_PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function daemonHelpText(): string {
  return `${pc.bold('clodex daemon')} v${VERSION}
Manage one persistent per-user Clodex process. The daemon owns the shared
HTTP proxy, OpenAI WebSocket pools, compaction checkpoints, metrics, and
session diagnostics.

${pc.bold('Usage:')}
  clodex daemon install     Install and start the macOS LaunchAgent
  clodex daemon start       Start the daemon if it is not running
  clodex daemon run         Run the Clodex daemon in the foreground
  clodex daemon status      Show service, session, and WebSocket status
  clodex daemon restart     Gracefully restart the daemon
  clodex daemon stop        Stop the current daemon
  clodex daemon uninstall   Stop and remove the LaunchAgent
  clodex daemon logs        Print daemon log paths

Run bare ${pc.bold('clodex')} to open the live Ink dashboard.
The existing ${pc.bold('clodex-claude')} wrapper automatically discovers the
daemon proxy on its restart-stable port (default ${DEFAULT_DAEMON_PORT}).
Account switching is explicit; quota or auth errors never fail over to another
account.`;
}

function daemonIsAlive(): boolean {
  const runtime = readDaemonRuntimeState();
  return Boolean(runtime && isPidAlive(runtime.pid));
}

async function waitForDaemon(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      await daemonControlRequest('/v1/health', { timeoutMs: 500 });
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } while (Date.now() < deadline);
  return false;
}

function runtimeMatchesInstall(
  runtime: DaemonRuntimeState,
  cliPath: string,
): boolean {
  return runtime.ready
    && runtime.version === VERSION
    && runtime.cliPath === cliPath
    && runtime.bunPath === process.execPath;
}

export async function ensureDaemonRunning(
  cliPath: string,
  timeoutMs = 5_000,
): Promise<DaemonRuntimeState> {
  try {
    await daemonControlRequest<DaemonHealthResponse>('/v1/health', { timeoutMs: 500 });
    const running = readDaemonRuntimeState();
    if (running && isPidAlive(running.pid) && runtimeMatchesInstall(running, cliPath)) {
      return running;
    }
    if (running && isPidAlive(running.pid)) {
      await daemonControlRequest('/v1/service/stop', {
        method: 'POST',
        body: { instanceId: running.instanceId },
        socketPath: running.controlSocketPath,
        timeoutMs: 1_000,
      });
      const deadline = Date.now() + timeoutMs;
      while (isPidAlive(running.pid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (isPidAlive(running.pid)) {
        throw new Error(`old Clodex daemon pid ${running.pid} did not stop during upgrade`);
      }
    }
  } catch {
    // Start below.
  }

  const stale = readDaemonRuntimeState();
  if (stale && isPidAlive(stale.pid)) {
    throw new Error(
      `Clodex daemon pid ${stale.pid} is running but its control socket is unavailable`,
    );
  }
  if (stale) removeDaemonRuntimeState(stale.instanceId);

  if (process.platform === 'darwin') {
    installDaemonLaunchAgent(cliPath);
  } else {
    const child = spawn(process.execPath, [cliPath, 'daemon', 'run'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  }
  if (!await waitForDaemon(timeoutMs)) {
    throw new Error('Clodex daemon did not become ready');
  }
  const runtime = readDaemonRuntimeState();
  if (!runtime || !isPidAlive(runtime.pid)) {
    throw new Error('Clodex daemon started without publishing valid runtime state');
  }
  return runtime;
}

export async function stopDaemon(timeoutMs = 5_000): Promise<boolean> {
  const runtime = readDaemonRuntimeState();
  if (!runtime || !isPidAlive(runtime.pid)) {
    if (runtime) removeDaemonRuntimeState(runtime.instanceId);
    return false;
  }
  await daemonControlRequest('/v1/service/stop', {
    method: 'POST',
    body: { instanceId: runtime.instanceId },
    socketPath: runtime.controlSocketPath,
    timeoutMs: 1_000,
  });
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(runtime.pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (isPidAlive(runtime.pid)) {
    throw new Error(`Clodex daemon pid ${runtime.pid} did not stop within ${timeoutMs}ms`);
  }
  return true;
}

export async function restartDaemonIfRunning(
  cliPath: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const previous = readDaemonRuntimeState();
  if (!previous || !isPidAlive(previous.pid)) return false;
  await daemonControlRequest('/v1/service/restart', {
    method: 'POST',
    socketPath: previous.controlSocketPath,
    timeoutMs: 1_000,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await daemonControlRequest<DaemonHealthResponse>('/v1/health', { timeoutMs: 300 });
      const current = readDaemonRuntimeState();
      if (
        current
        && current.instanceId !== previous.instanceId
        && isPidAlive(current.pid)
        && runtimeMatchesInstall(current, cliPath)
      ) return true;
    } catch {
      // Expected while the listener is being replaced.
    }
    if (!isPidAlive(previous.pid)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await ensureDaemonRunning(cliPath, Math.max(1_000, deadline - Date.now()));
  return true;
}

function formatStatus(status: DaemonStatusResponse): string {
  const ws = status.websocket;
  return [
    `${pc.green('●')} clodex ${status.version} ready (pid ${status.pid}, endpoint ${status.endpointPort}, proxy ${status.proxyPort})`,
    `  uptime: ${Math.floor(status.uptimeSeconds / 60)}m · active sessions: ${status.activeSessions}`,
    `  WebSockets: ${ws.total} total · ${ws.inFlight} in-flight · ${ws.established} established · ${ws.nursery} nursery · ${ws.isolated} isolated`,
  ].join('\n');
}

export async function runDaemonProcess(): Promise<number> {
  const previous = readDaemonRuntimeState();
  if (previous && isPidAlive(previous.pid) && previous.pid !== process.pid) {
    console.error(`Clodex daemon is already running (pid ${previous.pid})`);
    return 1;
  }
  if (previous) removeDaemonRuntimeState(previous.instanceId);

  const inferenceLogPath = getInferenceRequestLogPath();
  const webSocketDiagnosticsLogPath = getSessionLogPath(
    'daemon-websocket-diagnostics',
    'jsonl',
  );
  const collector = new DaemonInferenceCollector();
  const accounts = createDaemonAccountController();
  const secondwind = createDaemonSecondwindService();
  const unsubscribeTrace = subscribeInferenceTrace(event => collector.handle(event));

  let proxy: Awaited<ReturnType<typeof startConfiguredHttpProxy>> | undefined;
  let endpoint: ProxyHandle | undefined;
  let control: Awaited<ReturnType<typeof startDaemonControlApi>> | undefined;
  let runtime: ReturnType<typeof createDaemonRuntimeState> | undefined;
  let restartRequested = false;
  let shutdownResolve: (() => void) | undefined;
  const shutdown = new Promise<void>(resolve => {
    shutdownResolve = resolve;
  });
  const requestShutdown = () => shutdownResolve?.();
  const requestRestart = () => {
    restartRequested = true;
    requestShutdown();
  };

  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);

  try {
    const loaded = await loadHttpProxyRoutes();
    if (loaded.routes.length === 0) {
      throw new Error('No compatible favorite models are configured for the Clodex daemon');
    }
    const resolveRoute = (route: Parameters<typeof accounts.routeForTicket>[0], context: {
      launchTicket?: string;
    }) => accounts.routeForTicket(route, context.launchTicket);
    endpoint = await startProxyCatalog(
      loaded.routes,
      loaded.routes[0]!.aliasId,
      false,
      inferenceLogPath,
      undefined,
      webSocketDiagnosticsLogPath,
      loaded.aliases,
      resolveRoute,
      resolveDaemonEndpointPort(),
    );
    proxy = await startConfiguredHttpProxy(
      resolveDaemonPort(),
      false,
      inferenceLogPath,
      undefined,
      webSocketDiagnosticsLogPath,
      resolveRoute,
      endpoint,
      async context => secondwind.rewrite({
        body: context.body,
        request: context.request,
        sessionId: context.claudeSessionId
          ? context.claudeAgentId
            ? `${context.claudeSessionId}:${context.claudeAgentId}`
            : context.claudeSessionId
          : undefined,
        modelId: context.route.realModelId,
        processingMode: 'standard',
        recordMetrics: context.endpoint === 'messages',
      }),
    );
    runtime = createDaemonRuntimeState({
      pid: process.pid,
      bunPath: process.execPath,
      cliPath: process.argv[1] ?? '',
      ready: false,
      proxyPort: proxy.handle.port,
      endpointPort: endpoint.port,
      caPath: proxy.handle.caCertPath,
      controlSocketPath: getDaemonControlSocketPath(),
      version: VERSION,
    });
    writeDaemonRuntimeState(runtime);
    registerServerRuntimeState({
      mode: 'proxy',
      port: proxy.handle.port,
      pid: process.pid,
      caPath: proxy.handle.caCertPath,
      startedAt: runtime.startedAt,
    });

    const readyRuntime = { ...runtime, ready: true };
    control = await startDaemonControlApi({
      socketPath: runtime.controlSocketPath,
      runtime: readyRuntime,
      collector,
      accounts,
      secondwind,
      requestRestart,
      requestStop: requestShutdown,
    });
    runtime = readyRuntime;
    writeDaemonRuntimeState(runtime);
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_started',
      pid: process.pid,
      parentPid: process.ppid,
      host: proxy.handle.host,
      port: proxy.handle.port,
      reason: 'persistent daemon',
    });
    console.log(
      `Clodex daemon ready (pid ${process.pid}, endpoint ${endpoint.port}, proxy ${proxy.handle.port})`,
    );
    await shutdown;
  } catch (error) {
    console.error(`Clodex daemon failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    process.off('SIGINT', requestShutdown);
    process.off('SIGTERM', requestShutdown);
    unsubscribeTrace();
    secondwind.close();
    if (runtime) removeDaemonRuntimeState(runtime.instanceId);
    unregisterServerRuntimeState(process.pid);
    await control?.close();
    await proxy?.handle.close();
    endpoint?.close();
    writeProxyLifecycleLog(inferenceLogPath, {
      event: 'proxy_stopped',
      pid: process.pid,
      parentPid: process.ppid,
      port: proxy?.handle.port,
      reason: restartRequested ? 'daemon restart requested' : 'daemon shutdown',
    });
  }
  return restartRequested ? 75 : 0;
}

export async function runDaemonCommand(args: string[], cliPath: string): Promise<number> {
  const command = args.find(arg => !arg.startsWith('-')) ?? 'status';
  if (command === 'run') return runDaemonProcess();
  if (command === 'start') {
    try {
      const runtime = await ensureDaemonRunning(cliPath);
      console.log(
        `${pc.green('●')} Clodex daemon ready (pid ${runtime.pid}, endpoint ${runtime.endpointPort}, proxy ${runtime.proxyPort})`,
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (command === 'install') {
    const path = installDaemonLaunchAgent(cliPath);
    if (await waitForDaemon()) {
      console.log(`${pc.green('●')} installed and started ${path}`);
      return 0;
    }
    console.error(`LaunchAgent installed at ${path}, but the Clodex daemon did not become ready`);
    return 1;
  }
  if (command === 'uninstall') {
    const removed = uninstallDaemonLaunchAgent();
    if (daemonIsAlive()) await stopDaemon();
    console.log(removed ? 'Clodex daemon LaunchAgent removed.' : 'Clodex daemon LaunchAgent was not installed.');
    return 0;
  }
  if (command === 'restart') {
    try {
      await daemonControlRequest('/v1/service/restart', { method: 'POST' });
      console.log('Restart requested.');
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (command === 'stop') {
    try {
      if (!await stopDaemon()) {
        console.log('Clodex daemon is not running.');
        return 0;
      }
      console.log('Stopped Clodex daemon.');
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (command === 'logs') {
    console.log(`${getLogsPath()}/clodex-daemon.stdout.log`);
    console.log(`${getLogsPath()}/clodex-daemon.stderr.log`);
    console.log(getInferenceRequestLogPath());
    return 0;
  }
  if (command !== 'status') {
    console.error(`Unknown daemon command: ${command}`);
    console.log(daemonHelpText());
    return 1;
  }
  try {
    const status = await daemonControlRequest<DaemonStatusResponse>('/v1/status');
    console.log(args.includes('--json') ? JSON.stringify(status, null, 2) : formatStatus(status));
    return 0;
  } catch {
    console.log(`${pc.red('○')} Clodex daemon is not running`);
    console.log(`  LaunchAgent: ${getDaemonLaunchAgentPath()}`);
    return 1;
  }
}
