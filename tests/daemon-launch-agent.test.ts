import { describe, expect, it } from 'bun:test';
import { daemonLaunchAgentPlist } from '../src/daemon/launch-agent.js';
import {
  DEFAULT_DAEMON_PORT,
  requireDaemonRunning,
  resolveDaemonPort,
} from '../src/daemon/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('daemon launch agent', () => {
  it('pins Bun and CLI paths and restarts only abnormal exits', () => {
    const plist = daemonLaunchAgentPlist('/opt/bun', '/opt/clodex/cli.js', {
      HOME: '/Users/test',
      CLODEX_HOME: '/Users/test/.clodex',
      CLODEX_CREDENTIAL_HELPER: '/opt/clodex/helper',
      CLODEX_OPENAI_COMPACTION: 'legacy-value-must-not-pass-through',
      CLODEX_OPENAI_COMPACT_THRESHOLD: 'legacy-value-must-not-pass-through',
      CLODEX_DAEMON_ENDPOINT_PORT: '27778',
    });
    expect(plist).toContain('<string>/opt/bun</string>');
    expect(plist).toContain('<string>/opt/clodex/cli.js</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain('<string>Background</string>');
    expect(plist).toContain('<key>CLODEX_CREDENTIAL_HELPER</key>');
    expect(plist).toContain('<string>/opt/clodex/helper</string>');
    expect(plist).not.toContain('CLODEX_OPENAI_COMPACTION');
    expect(plist).not.toContain('CLODEX_OPENAI_COMPACT_THRESHOLD');
    expect(plist).not.toContain('CLODEX_DAEMON_ENDPOINT_PORT');
  });

  it('uses one stable endpoint port so sessions reconnect after daemon restarts', () => {
    expect(resolveDaemonPort({})).toBe(DEFAULT_DAEMON_PORT);
    expect(resolveDaemonPort({ CLODEX_DAEMON_PORT: '27777' })).toBe(27777);
    expect(() => resolveDaemonPort({ CLODEX_DAEMON_PORT: '0' }))
      .toThrow('between 1 and 65535');
  });

  it('requires an explicit daemon start for Claude launches', async () => {
    const previousHome = process.env['CLODEX_HOME'];
    process.env['CLODEX_HOME'] = mkdtempSync(join(tmpdir(), 'clodex-manual-start-'));
    try {
      await expect(requireDaemonRunning('/opt/clodex/cli.js'))
        .rejects.toThrow('Run `clodex start` first');
    } finally {
      if (previousHome === undefined) delete process.env['CLODEX_HOME'];
      else process.env['CLODEX_HOME'] = previousHome;
    }
  });
});
