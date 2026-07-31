import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { getAppHome, getDaemonLaunchAgentPath } from '../paths.js';

const DAEMON_LAUNCH_AGENT_LABEL = 'com.clodex.daemon';
const DAEMON_ENV_PASSTHROUGH = [
  'CLODEX_OPENAI_COMPACTION',
  'CLODEX_OPENAI_COMPACT_THRESHOLD',
  'CLODEX_STREAM_KEEPALIVE_INTERVAL_MS',
  'CLODEX_LOG_REQUEST_PREVIEW',
  'CLODEX_TRACE',
] as const;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function daemonLaunchAgentPlist(
  bunPath: string,
  cliPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const appHome = getAppHome(env);
  const daemonPort = env['CLODEX_DAEMON_PORT']?.trim();
  const helper = env['CLODEX_CREDENTIAL_HELPER']?.trim();
  const inherited = [
    ...(helper && isAbsolute(helper)
      ? [['CLODEX_CREDENTIAL_HELPER', helper] as const]
      : []),
    ...DAEMON_ENV_PASSTHROUGH.flatMap(name => {
      const value = env[name]?.trim();
      return value ? [[name, value] as const] : [];
    }),
  ].map(([name, value]) => `    <key>${name}</key>
    <string>${xmlEscape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLODEX_HOME</key>
    <string>${xmlEscape(appHome)}</string>
    ${daemonPort ? `<key>CLODEX_DAEMON_PORT</key>
    <string>${xmlEscape(daemonPort)}</string>` : ''}
${inherited}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(`${appHome}/logs/clodex-daemon.stdout.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(`${appHome}/logs/clodex-daemon.stderr.log`)}</string>
</dict>
</plist>
`;
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function launchctl(args: string[]): void {
  execFileSync('/bin/launchctl', args, { stdio: 'ignore' });
}

export function installDaemonLaunchAgent(
  cliPath: string,
  bunPath = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform !== 'darwin') {
    throw new Error('Automatic daemon supervision currently supports macOS launchd only');
  }
  const path = getDaemonLaunchAgentPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(`${getAppHome(env)}/logs`, { recursive: true, mode: 0o700 });
  writeFileSync(path, daemonLaunchAgentPlist(bunPath, cliPath, env), { mode: 0o600 });
  chmodSync(path, 0o600);
  try {
    launchctl(['bootout', launchDomain(), path]);
  } catch {
    // Not already loaded.
  }
  launchctl(['bootstrap', launchDomain(), path]);
  launchctl(['enable', `${launchDomain()}/${DAEMON_LAUNCH_AGENT_LABEL}`]);
  return path;
}

export function uninstallDaemonLaunchAgent(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = getDaemonLaunchAgentPath(env);
  try {
    readFileSync(path);
  } catch {
    return false;
  }
  try {
    launchctl(['bootout', launchDomain(), path]);
  } catch {
    // Remove a stale file even if launchd no longer knows it.
  }
  rmSync(path, { force: true });
  return true;
}
