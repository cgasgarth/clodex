import pc from 'picocolors';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runServerCommand } from './server/index.js';
import { resolveBridgeMode } from './config.js';
import { VERSION } from './constants.js';
import { runProvidersCommand, providersHelpText } from './providers-command.js';
import { refreshModelsDevCacheAsync } from './registry/models-dev.js';
import { runPatchCommand } from './patcher.js';
import { installOutboundProxyDispatcher } from './outbound-proxy.js';
import { daemonHelpText, ensureDaemonRunning, runDaemonCommand, stopDaemon } from './daemon/index.js';
import { accountsHelpText, runAccountsCommand } from './daemon/account-command.js';
import { parseArgs, runCatalogCommand } from './cli/args.js';
import { claudeHelpText, modelsHelpText, patchHelpText, printHelp, rootHelpText, serverHelpText } from './cli/help.js';
import { runModelsCommand } from './cli/models-command.js';
import { runClaudeCommand } from './cli/claude-command.js';

export { parseArgs } from './cli/args.js';
export { claudeHelpText, modelsHelpText, patchHelpText, rootHelpText, serverHelpText } from './cli/help.js';
export { catalogUsesNativeContextOwner, reportInactiveCatalogAliases } from './cli/catalog-runtime.js';
export { runModelsCommand } from './cli/models-command.js';
export { runClaudeCommand } from './cli/claude-command.js';

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  // Honor HTTP_PROXY/HTTPS_PROXY/NO_PROXY for clodex's own outbound calls
  // (no-op when no proxy env var is set; never throws).
  await installOutboundProxyDispatcher();

  const parsed = parseArgs(args);

  if (parsed.error) {
    console.error(pc.red(`\nError: ${parsed.error}\n`));
    printHelp(rootHelpText());
    return 1;
  }

  if (!parsed.showVersion) {
    refreshModelsDevCacheAsync();
  }

  if (parsed.command === 'root') {
    if (parsed.showVersion) {
      console.log(VERSION);
    } else if (parsed.showHelp || !process.stdin.isTTY || !process.stdout.isTTY) {
      printHelp(rootHelpText());
    } else {
      try {
        await ensureDaemonRunning(realpathSync(fileURLToPath(import.meta.url)));
      } catch (error) {
        console.error(
          pc.red(`Could not start the Clodex daemon: ${error instanceof Error ? error.message : String(error)}`),
        );
        return 1;
      }
      const { runDashboard } = await import('./dashboard.js');
      return runDashboard();
    }
    return 0;
  }

  if (parsed.command === 'start') {
    try {
      const runtime = await ensureDaemonRunning(
        realpathSync(fileURLToPath(import.meta.url)),
      );
      console.log(
        `Clodex daemon ready (pid ${runtime.pid}, endpoint ${runtime.port}).`,
      );
      return 0;
    } catch (error) {
      console.error(
        pc.red(`Could not start the Clodex daemon: ${error instanceof Error ? error.message : String(error)}`),
      );
      return 1;
    }
  }

  if (parsed.command === 'stop') {
    try {
      console.log(await stopDaemon()
        ? 'Stopped Clodex daemon.'
        : 'Clodex daemon is not running.');
      return 0;
    } catch (error) {
      console.error(
        pc.red(`Could not stop the Clodex daemon: ${error instanceof Error ? error.message : String(error)}`),
      );
      return 1;
    }
  }

  if (parsed.command === 'server') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(serverHelpText());
      return 0;
    }
    const bridgeMode = resolveBridgeMode('server', parsed.bridgeMode, {
      persist: Boolean(parsed.saveBridgeMode),
    });
    return runServerCommand({
      httpProxy: bridgeMode === 'proxy',
      quick: parsed.serverQuick,
      listenMode: parsed.serverListenMode,
      providersMode: parsed.serverProvidersMode,
      providerIds: parsed.serverProviderIds,
      maskGatewayIds: parsed.serverMaskGatewayIds,
      password: parsed.serverPassword,
      wsDiagnostics: parsed.serverWsDiagnostics,
      port: parsed.serverPort,
      noDiscovery: parsed.serverNoDiscovery,
    });
  }

  if (parsed.command === 'daemon') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(daemonHelpText());
      return 0;
    }
    return runDaemonCommand(parsed.claudeArgs, realpathSync(fileURLToPath(import.meta.url)));
  }

  if (parsed.command === 'accounts') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(accountsHelpText());
      return 0;
    }
    return runAccountsCommand(parsed.claudeArgs);
  }

  if (parsed.command === 'models') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(modelsHelpText());
      return 0;
    }
    return runCatalogCommand(() => runModelsCommand({
      list: parsed.favoritesList,
      alias: parsed.favoritesAlias,
      unalias: parsed.favoritesUnalias,
    }));
  }

  if (parsed.command === 'providers') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(providersHelpText());
      return 0;
    }
    if (parsed.trace) {
      process.env.CLODEX_TRACE = '1';
    }
    return runCatalogCommand(() => runProvidersCommand(parsed.claudeArgs));
  }

  if (parsed.command === 'patch') {
    if (parsed.showVersion) {
      console.log(VERSION);
      return 0;
    }
    if (parsed.showHelp) {
      printHelp(patchHelpText());
      return 0;
    }
    return runPatchCommand({ restore: parsed.patchRestore, trace: parsed.trace });
  }

  if (parsed.showVersion) {
    console.log(VERSION);
    return 0;
  }
  if (parsed.showHelp) {
    printHelp(claudeHelpText());
    return 0;
  }

  return runClaudeCommand(parsed);
}

function isCliEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((err: unknown) => {
    if (err === Symbol.for('clack:cancel')) {
      process.exit(0);
    }
    console.error(pc.red('\nUnexpected error:'), err);
    process.exit(1);
  });
}
