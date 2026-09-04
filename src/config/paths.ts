import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR_NAME = 'clodex';

interface HomeEnv {
  [name: string]: string | undefined;
  HOME?: string;
  CLODEX_HOME?: string;
  USERPROFILE?: string;
}

function userHome(env: HomeEnv = process.env): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

function resolveAppHomeOverride(env: HomeEnv = process.env): string | undefined {
  const override = env.CLODEX_HOME;
  return override?.trim() || undefined;
}

export function getAppHome(env: HomeEnv = process.env): string {
  const override = resolveAppHomeOverride(env);
  if (override) return override;
  return join(userHome(env), `.${APP_DIR_NAME}`);
}

export function getConfigPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'config.json');
}

export function getProvidersPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'providers.json');
}

export function getCredentialCleanupPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'credential-cleanup.json');
}

export function getLogsPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'logs');
}

export function getDaemonRuntimePath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'daemon-runtime.json');
}

export function getDaemonControlSocketPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'clodex.sock');
}

export function getDaemonMetricsPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'daemon-metrics.jsonl');
}

export function getDaemonMetricsDbPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'daemon-metrics.sqlite');
}

export function getResponsesCheckpointDbPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'responses-checkpoints.sqlite');
}

export function getDaemonAccountsPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'accounts.json');
}

export function getDaemonTicketKeyPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'launch-ticket-key');
}

export function getDaemonLaunchAgentPath(env: HomeEnv = process.env): string {
  return join(userHome(env), 'Library', 'LaunchAgents', 'com.clodex.daemon.plist');
}
