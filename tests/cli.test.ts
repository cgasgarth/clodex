// tests/cli.test.ts
import { describe, it, expect, vi, afterEach } from 'bun:test';
import {
  parseArgs,
  rootHelpText,
  serverHelpText,
  modelsHelpText,
  main,
} from '../src/cli.js';
import { VERSION } from '../src/constants.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  it('parses bare root command as the dashboard', () => {
    expect(parseArgs([])).toEqual({
      command: 'root',
      showHelp: false,
      showVersion: false,
      trace: false,
      claudeArgs: [],
    });
  });

  it('parses root help and version', () => {
    expect(parseArgs(['--help'])).toMatchObject({ command: 'root', showHelp: true });
    expect(parseArgs(['-h'])).toMatchObject({ command: 'root', showHelp: true });
    expect(parseArgs(['--version'])).toMatchObject({ command: 'root', showVersion: true });
    expect(parseArgs(['-v'])).toMatchObject({ command: 'root', showVersion: true });
  });

  it('parses daemon lifecycle shortcuts', () => {
    expect(parseArgs(['start'])).toMatchObject({ command: 'start' });
    expect(parseArgs(['stop'])).toMatchObject({ command: 'stop' });
    expect(parseArgs(['start', '--unknown']).error).toBe(
      'Unknown start option: --unknown',
    );
  });

  it('parses bridge-mode flags on the standalone server', () => {
    expect(parseArgs(['server', '--proxy'])).toMatchObject({
      command: 'server',
      bridgeMode: 'proxy',
    });
    expect(parseArgs(['server', '--endpoint'])).toMatchObject({
      command: 'server',
      bridgeMode: 'endpoint',
    });
    // bare commands leave bridgeMode undefined so the saved default applies
    expect(parseArgs(['server']).bridgeMode).toBeUndefined();
  });

  it('rejects the removed --http-proxy alias', () => {
    expect(parseArgs(['server', '--http-proxy'])).toMatchObject({
      error: 'Unknown server option: --http-proxy',
    });
  });

  it('parses --save-mode only together with a bridge-mode flag', () => {
    expect(parseArgs(['server', '--endpoint', '--save-mode'])).toMatchObject({
      command: 'server',
      bridgeMode: 'endpoint',
      saveBridgeMode: true,
    });
    // order does not matter
    expect(parseArgs(['server', '--save-mode', '--proxy'])).toMatchObject({
      bridgeMode: 'proxy',
      saveBridgeMode: true,
    });
    expect(parseArgs(['server', '--save-mode']).error).toContain('--endpoint or --proxy');
  });

  it('parses server options', () => {
    expect(parseArgs(['server', '--quick'])).toMatchObject({ command: 'server', serverQuick: true });
    expect(parseArgs(['server', '--listen', 'network'])).toMatchObject({ serverListenMode: 'network' });
    expect(parseArgs(['server', '--listen=bogus'])).toMatchObject({ error: '--listen must be "local" or "network"' });
    expect(parseArgs(['server', '--providers', 'favorites'])).toMatchObject({ serverProvidersMode: 'favorites' });
    expect(parseArgs(['server', '--providers=openai,openai-oauth'])).toMatchObject({
      serverProvidersMode: 'specific',
      serverProviderIds: ['openai', 'openai-oauth'],
    });
    expect(parseArgs(['server', '--password', 'pw'])).toMatchObject({ serverPassword: 'pw' });
    expect(parseArgs(['server', '--port', '8080'])).toMatchObject({ serverPort: 8080 });
    expect(parseArgs(['server', '--port', '99999'])).toMatchObject({ error: '--port must be an integer between 1 and 65535' });
    expect(parseArgs(['server', '--no-discovery'])).toMatchObject({ command: 'server', serverNoDiscovery: true });
    const proxyNoDiscovery = parseArgs(['server', '--proxy', '--no-discovery']);
    expect(proxyNoDiscovery).toMatchObject({ bridgeMode: 'proxy', serverNoDiscovery: true });
    expect(proxyNoDiscovery.error).toBeUndefined();
    expect(parseArgs(['server', '--bogus'])).toMatchObject({ error: 'Unknown server option: --bogus' });
  });

  it('parses models/favorites options', () => {
    expect(parseArgs(['models'])).toMatchObject({ command: 'models' });
    expect(parseArgs(['favorites'])).toMatchObject({ command: 'models' });
    expect(parseArgs(['models', '--list'])).toMatchObject({ favoritesList: true });
    expect(parseArgs(['models', '--alias', 'sol=clodex:openai-oauth:gpt-5.6-sol'])).toMatchObject({
      favoritesAlias: 'sol=clodex:openai-oauth:gpt-5.6-sol',
    });
    expect(parseArgs(['models', '--unalias', 'sol'])).toMatchObject({ favoritesUnalias: 'sol' });
    expect(parseArgs(['models', '--agy'])).toMatchObject({ error: 'Unknown models option: --agy' });
  });

  it('rejects stripped commands', () => {
    for (const cmd of ['claude', 'ui', 'codex', 'codex-app', 'chatgpt', 'agy', 'antigravity', 'antigravity-ide', 'claude-app']) {
      expect(parseArgs([cmd]).error, cmd).toBe(`Unknown command: ${cmd}`);
    }
  });

  it('rejects unknown root options', () => {
    expect(parseArgs(['--ai']).error).toBe('Unknown root option: --ai');
  });
});

describe('help text', () => {
  const helps = [rootHelpText(), serverHelpText(), modelsHelpText()];

  it('brands every help screen as clodex', () => {
    for (const help of helps) {
      expect(help).toContain('clodex');
      expect(help).not.toContain('relay-ai');
      expect(help).not.toContain('relay:');
      expect(help).not.toContain('Relay AI');
    }
    expect(rootHelpText()).toContain(`v${VERSION}`);
  });

  it('mentions no stripped features anywhere in help', () => {
    for (const help of helps) {
      expect(help).not.toContain('antigravity');
      expect(help).not.toContain('OpenCode');
      expect(help).not.toContain('Zen');
      expect(help).not.toContain('subscription tier');
    }
  });

  it('documents plain Claude startup and standalone server bridge modes', () => {
    const root = rootHelpText();
    expect(root).toContain('plain claude');
    expect(root).not.toContain('clodex claude');
    expect(root).toContain('clodex server');
    expect(root).toContain('clodex models');
    expect(root).toContain('clodex providers');
    expect(root).toContain('standalone gateway');
    expect(serverHelpText()).toContain('--endpoint');
    expect(serverHelpText()).toContain('--proxy');
    expect(serverHelpText()).toContain('--save-mode');
    expect(serverHelpText()).toContain('--no-discovery');
  });

  it('no longer mentions the removed --http-proxy alias', () => {
    for (const help of helps) {
      expect(help).not.toContain('--http-proxy');
    }
  });
});

describe('main dispatch', () => {
  it('prints version for --version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(VERSION);
  });

  it('prints root help for unknown commands and returns 1', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['nope']);
    expect(code).toBe(1);
    expect(error.mock.calls.some(call => String(call[0]).includes('Unknown command: nope'))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).includes('clodex'))).toBe(true);
  });

});
