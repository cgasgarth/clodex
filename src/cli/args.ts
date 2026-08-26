import * as p from '@clack/prompts';
import { readFileSync } from 'node:fs';
import type { ParsedArgs } from '../types.js';
import { restartDaemonIfRunning } from '../daemon/index.js';
import { getConfigPath, getProvidersPath } from '../config/paths.js';
import { resolveCliRuntimePaths } from './runtime-paths.js';
import { loadHttpProxyRoutes } from '../http-proxy/index.js';
import { syncClaudeModelPickerSettings } from '../runtime/claude-settings.js';

function readCatalogFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function daemonCatalogSnapshot(): string {
  return `${readCatalogFile(getConfigPath())}\0${readCatalogFile(getProvidersPath())}`;
}

export async function runCatalogCommand(
  run: () => Promise<number>,
  cliPath = resolveCliRuntimePaths(import.meta.url).cliPath,
): Promise<number> {
  const before = daemonCatalogSnapshot();
  const result = await run();
  if (result !== 0 || daemonCatalogSnapshot() === before) return result;
  try {
    const catalog = await loadHttpProxyRoutes();
    syncClaudeModelPickerSettings(catalog.routes, catalog.aliases);
  } catch (error) {
    p.log.error(
      `Saved the catalog, but Claude settings could not update: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
  try {
    const restarted = await restartDaemonIfRunning(cliPath);
    if (restarted) p.log.info('Reloaded the persistent daemon catalog.');
  } catch (error) {
    p.log.warn(
      `Saved the catalog, but the Clodex daemon could not reload it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return result;
}

function consumeServerOptionValue(
  arg: string,
  rest: string[],
  index: number,
  flag: string,
  parsed: ParsedArgs,
): { value: string; next: number } | null {
  if (arg.startsWith(`${flag}=`)) {
    return { value: arg.slice(flag.length + 1), next: index };
  }
  if (arg !== flag) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) {
    parsed.error = `Missing value for ${flag}`;
    return null;
  }
  return { value, next: index + 1 };
}

function applyServerProvidersOption(value: string, parsed: ParsedArgs): void {
  const trimmed = value.trim();
  if (trimmed === 'all') {
    parsed.serverProvidersMode = 'all';
    parsed.serverProviderIds = undefined;
    return;
  }
  if (trimmed === 'favorites') {
    parsed.serverProvidersMode = 'favorites';
    parsed.serverProviderIds = undefined;
    return;
  }

  const ids = trimmed.split(',').map(id => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    parsed.error = 'Missing provider ids for --providers';
    return;
  }
  parsed.serverProvidersMode = 'specific';
  parsed.serverProviderIds = ids;
}

function emptyParsed(command: ParsedArgs['command']): ParsedArgs {
  return {
    command,
    showHelp: false,
    showVersion: false,
    trace: false,
    claudeArgs: [],
  };
}

function consumeBridgeModeFlag(arg: string, parsed: ParsedArgs): boolean {
  if (arg === '--endpoint') {
    parsed.bridgeMode = 'endpoint';
    return true;
  }
  if (arg === '--proxy') {
    parsed.bridgeMode = 'proxy';
    return true;
  }
  return false;
}

/** --save-mode is only meaningful with an explicit mode supported by the command. */
function validateSaveModeFlag(parsed: ParsedArgs): void {
  if (parsed.saveBridgeMode && !parsed.bridgeMode && !parsed.error) {
    parsed.error = '--save-mode saves the server bridge mode — combine it with --endpoint or --proxy';
  }
}

export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) return emptyParsed('root');

  const [first, ...rest] = args;

  if (first === '--help' || first === '-h') {
    return { ...emptyParsed('root'), showHelp: true };
  }
  if (first === '--version' || first === '-v') {
    return { ...emptyParsed('root'), showVersion: true };
  }

  if (first === 'start' || first === 'stop') {
    const parsed = emptyParsed(first);
    if (rest.length > 0) parsed.error = `Unknown ${first} option: ${rest[0]}`;
    return parsed;
  }

  if (first === 'server') {
    const parsed = emptyParsed('server');
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (consumeBridgeModeFlag(arg, parsed)) continue;
      else if (arg === '--save-mode') parsed.saveBridgeMode = true;
      else if (arg === '--ws-diagnostics') parsed.serverWsDiagnostics = true;
      else if (arg === '--no-discovery') parsed.serverNoDiscovery = true;
      else if (arg === '--quick' || arg === '--saved') parsed.serverQuick = true;
      else if (arg === '--mask-gateway-ids') parsed.serverMaskGatewayIds = true;
      else if (arg === '--no-mask-gateway-ids') parsed.serverMaskGatewayIds = false;
      else if (arg === '--listen' || arg.startsWith('--listen=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--listen', parsed);
        if (!consumed) return parsed;
        if (consumed.value !== 'local' && consumed.value !== 'network') {
          parsed.error = '--listen must be "local" or "network"';
          return parsed;
        }
        parsed.serverListenMode = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--providers' || arg.startsWith('--providers=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--providers', parsed);
        if (!consumed) return parsed;
        applyServerProvidersOption(consumed.value, parsed);
        if (parsed.error) return parsed;
        i = consumed.next;
      }
      else if (arg === '--password' || arg.startsWith('--password=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--password', parsed);
        if (!consumed) return parsed;
        parsed.serverPassword = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--port' || arg.startsWith('--port=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--port', parsed);
        if (!consumed) return parsed;
        const port = Number(consumed.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          parsed.error = '--port must be an integer between 1 and 65535';
          return parsed;
        }
        parsed.serverPort = port;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown server option: ${arg}`;
    }
    validateSaveModeFlag(parsed);
    return parsed;
  }

  if (first === 'daemon') {
    const parsed = emptyParsed('daemon');
    parsed.claudeArgs = rest;
    if (rest.includes('--help') || rest.includes('-h')) parsed.showHelp = true;
    if (rest.includes('--version') || rest.includes('-v')) parsed.showVersion = true;
    return parsed;
  }

  if (first === 'accounts') {
    const parsed = emptyParsed('accounts');
    parsed.claudeArgs = rest;
    if (rest.includes('--help') || rest.includes('-h')) parsed.showHelp = true;
    if (rest.includes('--version') || rest.includes('-v')) parsed.showVersion = true;
    return parsed;
  }

  if (first === 'models' || first === 'favorites') {
    const parsed = emptyParsed('models');
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (arg === '--list') parsed.favoritesList = true;
      else if (arg === '--alias' || arg.startsWith('--alias=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--alias', parsed);
        if (!consumed) return parsed;
        parsed.favoritesAlias = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--unalias' || arg.startsWith('--unalias=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--unalias', parsed);
        if (!consumed) return parsed;
        parsed.favoritesUnalias = consumed.value;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown models option: ${arg}`;
    }
    return parsed;
  }

  if (first === 'providers') {
    const parsed = emptyParsed('providers');
    parsed.claudeArgs = [];
    for (const arg of rest) {
      if (arg === '--trace') parsed.trace = true;
      else if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else parsed.claudeArgs.push(arg);
    }
    return parsed;
  }

  return {
    ...emptyParsed('root'),
    error: first?.startsWith('-') ? `Unknown root option: ${first}` : `Unknown command: ${first}`,
  };
}
