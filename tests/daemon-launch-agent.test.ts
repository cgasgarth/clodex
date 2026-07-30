import { describe, expect, it } from 'bun:test';
import { daemonLaunchAgentPlist } from '../src/daemon/launch-agent.js';
import {
  DEFAULT_DAEMON_PORT,
  resolveDaemonPort,
} from '../src/daemon/index.js';

describe('daemon launch agent', () => {
  it('pins Bun and CLI paths and restarts only abnormal exits', () => {
    const plist = daemonLaunchAgentPlist('/opt/bun', '/opt/clodex/cli.js', {
      HOME: '/Users/test',
      CLODEX_HOME: '/Users/test/.clodex',
      CLODEX_CREDENTIAL_HELPER: '/opt/clodex/helper',
      CLODEX_OPENAI_COMPACTION: '1',
      CLODEX_OPENAI_COMPACT_THRESHOLD: '250000',
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
    expect(plist).toContain('<key>CLODEX_OPENAI_COMPACT_THRESHOLD</key>');
    expect(plist).toContain('<string>250000</string>');
    expect(plist).not.toContain('CLODEX_DAEMON_ENDPOINT_PORT');
  });

  it('uses one stable endpoint port so sessions reconnect after daemon restarts', () => {
    expect(resolveDaemonPort({})).toBe(DEFAULT_DAEMON_PORT);
    expect(resolveDaemonPort({ CLODEX_DAEMON_PORT: '27777' })).toBe(27777);
    expect(() => resolveDaemonPort({ CLODEX_DAEMON_PORT: '0' }))
      .toThrow('between 1 and 65535');
  });
});
