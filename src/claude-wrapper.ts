// src/claude-wrapper.ts — the `clodex-claude` bin.
//
// A tiny, fast exec-style wrapper around the Claude Code binary that injects
// bridge env for a running standalone `clodex server` (discovered via
// ~/.clodex/server-runtime.json). Two invocation shapes:
//
//   1. CLAUDE_CODE_PROCESS_WRAPPER contract: Claude Code invokes
//      `clodex-claude <claude-binary-path> <args...>` for every process it
//      spawns (agents view sessions, background agents). First arg is the
//      claude binary to exec.
//   2. Direct terminal use: `clodex-claude [args...]` — the claude binary is
//      discovered from the same runtime record used by plain Claude Code
//      (CLODEX_CLAUDE_PATH override, config override, PATH, fallbacks).
//
// With a live proxy-mode server: HTTPS_PROXY/HTTP_PROXY + NODE_EXTRA_CA_CERTS
// point at it and ANTHROPIC_BASE_URL is removed (claude keeps its own
// Anthropic auth — this is the recommended mode). With a live endpoint-mode
// server: ANTHROPIC_BASE_URL points at the gateway. With no live server the
// env is passed through untouched, so claude always launches.
//
// The wrapper REPLACES its own process image with claude (execve) rather than
// parenting it — see execIntoClaude below for why that distinction matters.
//
// This file must stay a thin shell over pure helpers (wrapper-env.ts,
// server-runtime.ts) with minimal imports — it runs for every spawned agent.

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { findClaudeBinary } from './runtime/launch.js';
import { waitForTcpListenerCandidate } from './transport/listener-ready.js';
import {
  orderWrapperServerCandidates,
  isPidAlive,
  readLiveServerRuntimeStates,
  type ServerRuntimeState,
} from './runtime/server-runtime.js';
import { computeWrapperEnv, wrapperRequiresServer } from './runtime/wrapper-env.js';
import { daemonControlRequest } from './daemon/control-client.js';
import { readDaemonRuntimeState } from './daemon/runtime.js';

const isWindows = process.platform === 'win32';
const WRAPPER_SERVER_READY_TIMEOUT_MS = 500;

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!isWindows) accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace this process with claude instead of parenting it. Returns when exec
 * is unavailable or declined, leaving the caller to spawn a child instead.
 *
 * Claude Code starts each background pty host with `detached: true` so the
 * process it spawns leads its own process group, then delivers terminal
 * resizes to that group with `process.kill(-process.pid, 'SIGWINCH')`. A
 * wrapper that spawns claude as a child takes the group-leader role for
 * itself: claude's pid no longer matches its group id, the signal fails with
 * ESRCH inside Claude Code's silent `catch {}`, and every background session
 * stays frozen at the startup size it was given on the command line (200x50)
 * however the terminal is later resized. Interactive sessions hid the bug
 * because there the kernel delivers SIGWINCH through the controlling terminal.
 *
 * Replacing the process image keeps the pid, process group, and inherited fds
 * exactly as Claude Code handed them out, so it cannot tell this wrapper apart
 * from launching claude directly. That also makes the signal forwarding and
 * exit-code mapping below unnecessary on this path.
 *
 * Bun exposes `process.execve` on POSIX. Windows falls back to spawning, which
 * behaves correctly apart from background pty resizes.
 *
 * A failed exec cannot fall back to spawning: on syscall failure `execve`
 * aborts with a native crash dump (exit 134) rather than throwing. So re-check
 * the binary immediately before the call — `main` has awaited up to 500ms of
 * server probing since it first looked, and Claude Code replaces its own
 * binary when it self-updates — and let a vanished or unreadable file take the
 * spawn path, which still reports it as a one-line error and exit 127. Only
 * argument and platform validation, which run before the syscall, are
 * catchable; claude has not been launched when they throw.
 */
function execIntoClaude(file: string, args: string[], env: NodeJS.ProcessEnv): void {
  if (isWindows || process.execve === undefined) return;
  if (!isExecutableFile(file)) return;

  try {
    process.execve(file, [file, ...args], env);
  } catch {
    // Rejected before the syscall — leave claude to the spawn path below.
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv[0] === '--check';

  let claudePath: string | null = null;
  let claudeArgs: string[] = [];
  if (checkOnly) {
    // Readiness checks validate discovery and TCP state without launching Claude.
  } else if (argv[0] && isExecutableFile(argv[0])) {
    // CLAUDE_CODE_PROCESS_WRAPPER shape: first arg is the claude binary path.
    claudePath = argv[0];
    claudeArgs = argv.slice(1);
  } else {
    claudePath = findClaudeBinary();
    claudeArgs = argv;
  }

  if (!checkOnly && !claudePath) {
    process.stderr.write('clodex-claude: could not find the claude binary (set CLODEX_CLAUDE_PATH)\n');
    process.exit(127);
  }

  let requestedAccount: string | undefined = process.env['CLODEX_ACCOUNT']?.trim() || undefined;
  const accountFlagIndex = claudeArgs.findIndex(arg =>
    arg === '--clodex-account' || arg.startsWith('--clodex-account='),
  );
  if (accountFlagIndex >= 0) {
    const flag = claudeArgs[accountFlagIndex]!;
    if (flag.includes('=')) {
      requestedAccount = flag.slice(flag.indexOf('=') + 1).trim() || undefined;
      claudeArgs.splice(accountFlagIndex, 1);
    } else {
      requestedAccount = claudeArgs[accountFlagIndex + 1]?.trim() || undefined;
      claudeArgs.splice(accountFlagIndex, requestedAccount ? 2 : 1);
    }
  }

  let launchTicket = process.env['CLODEX_LAUNCH_TICKET'];
  const daemon = readDaemonRuntimeState();
  const liveServers = readLiveServerRuntimeStates();
  const daemonCandidate: ServerRuntimeState | undefined = daemon?.ready && isPidAlive(daemon.pid)
    ? {
        mode: 'endpoint',
        pid: daemon.pid,
        port: daemon.port,
        startedAt: daemon.startedAt,
      }
    : undefined;
  const mustUseDaemon = Boolean(
    daemonCandidate
    || launchTicket
    || requestedAccount
    || wrapperRequiresServer(process.env),
  );
  // A daemon-launched main session and every inherited workflow/subagent must
  // stay on the exact daemon process. Generic discovery remains only for
  // direct standalone-server wrapper use that has no daemon identity or ticket.
  const candidates = daemonCandidate
    ? [daemonCandidate]
    : mustUseDaemon
      ? []
      : orderWrapperServerCandidates(liveServers);
  const state: ServerRuntimeState | null = await waitForTcpListenerCandidate(
    '127.0.0.1',
    candidates,
    WRAPPER_SERVER_READY_TIMEOUT_MS,
    { retryFailure: result => result === 'timeout' },
  );
  if (checkOnly) process.exit(state ? 0 : 1);
  if (!state && mustUseDaemon) {
    process.stderr.write('clodex-claude: the persistent clodex daemon is unavailable\n');
    process.exit(1);
  }

  if (
    daemon?.ready
    && state
    && daemon.pid === state.pid
    && state.mode === 'endpoint'
    && daemon.port === state.port
    && (!launchTicket || requestedAccount)
  ) {
    try {
      const attached = await daemonControlRequest<{ ticket: string } | null>('/v1/launches/attach', {
        method: 'POST',
        body: requestedAccount ? { accountId: requestedAccount } : {},
        socketPath: daemon.controlSocketPath,
        timeoutMs: 5_000,
      });
      launchTicket = attached?.ticket;
    } catch (error) {
      process.stderr.write(
        `clodex-claude: could not attach the OpenAI account${
          requestedAccount ? ` ${JSON.stringify(requestedAccount)}` : ''
        }: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  }
  const env = computeWrapperEnv(process.env, state, launchTicket);

  execIntoClaude(claudePath!, claudeArgs, env);

  // Only reached when exec is unavailable or failed.
  const child = spawn(claudePath!, claudeArgs, {
    stdio: 'inherit',
    env,
    shell: isWindows,
  });

  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  child.on('error', err => {
    process.stderr.write(`clodex-claude: failed to launch ${claudePath}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      const signum = osConstants.signals[signal];
      process.exit(signum ? 128 + signum : 1);
    }
    process.exit(code ?? 0);
  });
}

void main();
