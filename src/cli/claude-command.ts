import pc from 'picocolors';
import { relayIntro, providerSelectOption } from '../ui/prompts.js';
import * as p from '@clack/prompts';
import { findClaudeBinary, launchClaude } from '../runtime/launch.js';
import { detectConflicts, buildChildEnv } from '../config/environment.js';
import {
  claudeCodeClientModelId,
  normalizeRouteLookupId,
  stripOneMContextSuffix,
} from '../models/context-model-id.js';
import { needsFirstRunSetup, runFirstRunWizard } from './first-run.js';
import { startProxy } from '../proxy/index.js';
import type { ProxyHandle } from '../proxy/index.js';
import {
  buildCatalogRoutes,
  makeRouteResolver,
  resolveCatalogModelAliases,
} from '../models/catalog.js';
import { loadPreferences, savePreferences, recordLaunchSelection } from '../config/config.js';
import { pickLocalModel } from './prompts.js';
import { fetchProviderCatalog, providersForPicker, resolveLocalProviderApiKey } from '../models/provider-catalog.js';
import type { ParsedArgs, FavoriteModel, LocalProvider, LocalProviderModel } from '../types.js';
import {
  getSessionLogPath,
  prepareClaudeTraceLog,
  printTraceLog,
} from '../observability/trace-log.js';
import { providersForTarget } from '../models/target-compatibility.js';
import { setAgentStdoutMode, isAgentStdoutMode } from '../agents/io.js';
import {
  findProviderAndModel,
  normalizeClaudeAgentArgs,
  planLaunchWizard,
  wantsCleanAgentStdout,
} from '../runtime/launch-target.js';
import { loadHttpProxyRoutes } from '../http-proxy/index.js';
import { runLaunchPatchCheck } from '../patcher/index.js';
import { ensureDaemonRunning } from '../daemon/index.js';
import { daemonControlRequest } from '../daemon/control-client.js';
import { LAUNCH_TICKET_HEADER, setAnthropicCustomHeader } from '../runtime/wrapper-env.js';
import { getOrCreateProxyToken } from '../proxy/token.js';
import { catalogUsesNativeContextOwner, launchClaudeViaCatalog } from './catalog-runtime.js';
import { resolveCliRuntimePaths } from './runtime-paths.js';
import type { CliRuntimePaths } from './runtime-paths.js';

interface LaunchAttachRequest {
  accountId?: string;
  fast?: true;
}

function requestedClaudeModel(args: string[]): string | undefined {
  let index = -1;
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    const arg = args[cursor]!;
    if (arg === '--model' || arg.startsWith('--model=')) index = cursor;
  }
  if (index < 0) return undefined;
  const flag = args[index]!;
  return stripOneMContextSuffix(
    flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : (args[index + 1] ?? ''),
  ).trim() || undefined;
}

async function selectSavedFavorite(
  favorites: FavoriteModel[],
  providers: LocalProvider[],
): Promise<{ provider: LocalProvider; model: LocalProviderModel } | null> {
  const available = favorites.flatMap(favorite => {
    const provider = providers.find(candidate => candidate.id === favorite.providerId);
    const model = provider?.models.find(candidate => candidate.id === favorite.modelId);
    return provider && model ? [{ provider, model }] : [];
  });
  if (available.length === 0) {
    p.log.warn('No saved favorites are currently available.');
    return null;
  }
  const pickedIndex = await p.select<string>({
    message: 'Starting model?',
    options: available.map((favorite, index) => ({
      value: String(index),
      label: `${favorite.model.name || favorite.model.id} — ${favorite.provider.name}`,
      hint: favorite.model.id,
    })),
    initialValue: '0',
  });
  if (p.isCancel(pickedIndex)) {
    p.cancel('Cancelled.');
    return null;
  }
  return available[Number(pickedIndex)] ?? null;
}

async function runClaudeDaemonEndpointCommand(
  parsed: ParsedArgs,
  claudeArgs: string[],
  agentStdout: boolean,
  runtimePaths: CliRuntimePaths,
): Promise<number> {
  let runtime: Awaited<ReturnType<typeof ensureDaemonRunning>>;
  try {
    runtime = await ensureDaemonRunning(runtimePaths.cliPath);
  } catch (error) {
    p.log.error(`Failed to start the Clodex daemon: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let launchTicket: string | undefined;
  try {
    const body: LaunchAttachRequest = {};
    if (process.env['CLODEX_ACCOUNT']) body.accountId = process.env['CLODEX_ACCOUNT'];
    if (parsed.fast) body.fast = true;
    const attached = await daemonControlRequest<{ ticket: string } | null>('/v1/launches/attach', {
      method: 'POST',
      body,
      socketPath: runtime.controlSocketPath,
      timeoutMs: 5_000,
    });
    launchTicket = attached?.ticket;
  } catch (error) {
    p.log.error(`Could not attach the OpenAI account: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const loaded = await loadHttpProxyRoutes();
  const requestedModel = requestedClaudeModel(claudeArgs);
  const defaultAlias = loaded.aliases[0]?.name ?? loaded.routes[0]?.aliasId;
  const launchModel = requestedModel ?? defaultAlias;
  if (!launchModel) {
    p.log.error('No compatible model is configured for the persistent daemon.');
    return 1;
  }
  const alias = loaded.aliases.find(item =>
    normalizeRouteLookupId(item.name) === normalizeRouteLookupId(launchModel),
  );
  const routeLookup = alias?.routeId ?? launchModel;
  const route = loaded.routes.find(item =>
    normalizeRouteLookupId(item.aliasId) === normalizeRouteLookupId(routeLookup),
  ) ?? loaded.routes[0];
  const apiKey = getOrCreateProxyToken();
  const childEnv = buildChildEnv(
    `http://127.0.0.1:${runtime.port}`,
    launchModel,
    apiKey,
    runtime.port,
    route?.contextWindow,
    true,
    catalogUsesNativeContextOwner(loaded.routes),
  );
  if (parsed.fast) childEnv['CLODEX_CLAUDE_FAST_DEFAULT'] = '1';
  if (launchTicket) {
    childEnv['CLODEX_LAUNCH_TICKET'] = launchTicket;
    setAnthropicCustomHeader(childEnv, LAUNCH_TICKET_HEADER, launchTicket);
  }
  childEnv['CLODEX_REQUIRE_SERVER'] = '1';
  childEnv['CLAUDE_CODE_PROCESS_WRAPPER'] ??= runtimePaths.processWrapperPath;
  if (!agentStdout) {
    p.log.info(
      `Using ${launchModel} through the shared Clodex daemon endpoint on port ${runtime.port}.`,
    );
  }
  const debugLogPath = parsed.trace
    ? prepareClaudeTraceLog(getSessionLogPath('claude-debug'))
    : undefined;
  const traceArgs = debugLogPath ? ['--debug-file', debugLogPath] : [];
  const exitCode = await launchClaude(childEnv, launchModel, [...traceArgs, ...claudeArgs]);
  if (debugLogPath) printTraceLog(debugLogPath);
  return exitCode;
}

export async function runClaudeCommand(
  parsed: ParsedArgs,
  runtimePaths: CliRuntimePaths = resolveCliRuntimePaths(import.meta.url),
): Promise<number> {
  const { dryRun, trace, launchProvider, launchModel } = parsed;
  const claudeArgs = normalizeClaudeAgentArgs(parsed.claudeArgs);
  const agentStdout = wantsCleanAgentStdout('claude', claudeArgs);
  setAgentStdoutMode(agentStdout);

  // Prerequisite: claude binary
  const claudePath = findClaudeBinary();
  if (!claudePath) {
    console.error(pc.red('\nError: claude binary not found on PATH.\n'));
    console.error('Install Claude Code:');
    console.error('  bun add --global @anthropic-ai/claude-code\n');
    return 1;
  }

  if (parsed.bridgeMode === 'proxy') {
    p.log.error('clodex claude uses one persistent endpoint; --proxy is only available to clodex server.');
    return 1;
  }
  if (parsed.bridgeMode === 'endpoint' && parsed.saveBridgeMode && !dryRun) {
    savePreferences({ claudeBridgeMode: 'endpoint' });
  }

  // Launch-time patch check: prompt on TTY, notice otherwise. Never blocks the launch.
  await runLaunchPatchCheck({ agentStdout, dryRun });

  if (
    !parsed.dryRun
    && !parsed.launchProvider
    && !parsed.launchModel
  ) {
    return runClaudeDaemonEndpointCommand(parsed, claudeArgs, agentStdout, runtimePaths);
  }

  const prefs: ReturnType<typeof loadPreferences> = dryRun ? {} : loadPreferences();
  const conflicts = detectConflicts();

  const favorites = prefs.favoriteModels ?? [];
  const launchPlan = planLaunchWizard({
    explicit: { providerId: launchProvider, modelId: launchModel },
    childArgs: claudeArgs,
    agent: 'claude',
    prefs,
  });
  if (launchPlan.error) {
    console.error(pc.red(`\nError: ${launchPlan.error}\n`));
    return 1;
  }
  // Without a TTY the interactive wizard cannot run — fall back to the last-used
  // provider/model (like print mode) instead of crashing on a clack prompt.
  if (!launchPlan.skip && !process.stdin.isTTY) {
    const savedPrefs = dryRun ? loadPreferences() : prefs;
    if (savedPrefs.lastProvider && savedPrefs.lastModel) {
      launchPlan.skip = true;
      launchPlan.target = { providerId: savedPrefs.lastProvider, modelId: savedPrefs.lastModel };
    } else {
      console.error(pc.red('\nError: interactive wizard requires a TTY. Pass --provider and --model, or run once interactively.\n'));
      return 1;
    }
  }
  const switchMenuActive = favorites.length > 0 && !launchPlan.skip;

  if (!agentStdout) relayIntro('Claude Code');

  if (!dryRun && needsFirstRunSetup()) {
    const firstRun = await runFirstRunWizard(trace);
    if (firstRun === 'cancel') return 0;
  }

  let catalog: Awaited<ReturnType<typeof fetchProviderCatalog>>;
  if (agentStdout) {
    try {
      catalog = await fetchProviderCatalog();
    } catch (err) {
      console.error(pc.red(String(err instanceof Error ? err.message : err)));
      return 1;
    }
  } else {
    const catalogSpinner = p.spinner();
    catalogSpinner.start('Loading your providers...');
    try {
      catalog = await fetchProviderCatalog();
    } catch (err) {
      catalogSpinner.stop('');
      console.error(pc.red(String(err instanceof Error ? err.message : err)));
      return 1;
    }
    catalogSpinner.stop('');
  }

  const allProviders = providersForTarget(providersForPicker(catalog), 'claude');
  if (allProviders.length === 0) {
    p.log.warn('No providers available.');
    p.log.info(pc.dim('Run clodex providers to get started.'));
    return 0;
  }

  const providerOptions = allProviders.map(lp => providerSelectOption(lp));

  if (switchMenuActive) {
    providerOptions.unshift({
      value: '__favorites__',
      label: '⭐ Favorites Catalog',
      hint: `${favorites.length} saved favorites`,
    });
  }

  const initialProvider =
    prefs.lastProvider && providerOptions.some(o => o.value === prefs.lastProvider)
      ? prefs.lastProvider
      : providerOptions[0]!.value;

  let activeProvider: LocalProvider;
  let selectedModel: LocalProviderModel;

  if (launchPlan.skip && launchPlan.target) {
    const resolved = findProviderAndModel(allProviders, launchPlan.target);
    if (!resolved) {
      p.log.error(
        `Provider/model not found: ${launchPlan.target.providerId} / ${launchPlan.target.modelId}`,
      );
      return 1;
    }
    activeProvider = resolved.provider;
    selectedModel = resolved.model;
    if (!agentStdout) {
      p.log.step(`Using ${selectedModel.name || selectedModel.id} (${activeProvider.name})`);
    }
    if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
  } else {
    let currentInitialProvider = initialProvider;
    while (true) {
      const chosen = await p.select<string>({
        message: 'Which provider?',
        options: providerOptions,
        initialValue: currentInitialProvider,
      });

      if (p.isCancel(chosen)) {
        p.cancel('Cancelled.');
        return 0;
      }

      const providerChoice = chosen;

      if (providerChoice === '__favorites__') {
        const favorite = await selectSavedFavorite(favorites, allProviders);
        if (!favorite) return 0;
        activeProvider = favorite.provider;
        selectedModel = favorite.model;
        if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
        break;
      }
      activeProvider = allProviders.find(lp => lp.id === providerChoice)!;
      const pickedModelResult = await pickLocalModel(activeProvider, conflicts, prefs);
      if (pickedModelResult === 'back') {
        currentInitialProvider = activeProvider.id;
        continue;
      }
      if (!pickedModelResult) return 0;
      selectedModel = pickedModelResult;

      if (!dryRun) recordLaunchSelection('claude', activeProvider.id, selectedModel.id, prefs);
      break;
    }
  }

  const localProviders = catalog.length > 0 ? catalog : null;
  if (switchMenuActive) {
    const resolveRoute = makeRouteResolver(
      localProviders,
    );
    const startingRoute = resolveRoute(activeProvider.id, selectedModel.id) ?? null;
    if (!startingRoute) {
      p.log.error('Could not resolve a proxy route for the selected model.');
      return 1;
    }
    const { routes: catalogRoutes, droppedFavorites } = buildCatalogRoutes(startingRoute, favorites, resolveRoute);
    if (droppedFavorites.length > 0) {
      p.log.warn(
        `Skipping ${droppedFavorites.length} favorite${droppedFavorites.length === 1 ? '' : 's'} `
        + 'that are no longer available in /model',
      );
    }

    if (dryRun) {
      const endpoint = selectedModel.baseUrl ?? selectedModel.completionsUrl ?? '(unknown)';
      console.log('');
      console.log(pc.bold(pc.cyan('  DRY RUN — would execute (switch-menu mode):')));
      console.log('');
      console.log(`  ${pc.bold('Provider:')}      ${activeProvider.name}`);
      console.log(`  ${pc.bold('Starting model:')} ${selectedModel.id}`);
      console.log(`  ${pc.bold('Endpoint:')}      ${endpoint}`);
      console.log(`  ${pc.bold('/model catalog:')} ${catalogRoutes.length} model(s)`);
      catalogRoutes.forEach(r => console.log(`    ${pc.dim(r.displayName)}`));
      console.log('');
      console.log(pc.dim('  (dry run complete — Claude Code was NOT launched)'));
      console.log('');
      return 0;
    }

    return launchClaudeViaCatalog(
      catalogRoutes,
      startingRoute,
      resolveCatalogModelAliases(
        prefs.modelAliases,
        resolveRoute,
        catalogRoutes,
      ),
      selectedModel.contextWindow,
      trace,
      claudeArgs,
      parsed.fast,
    );
  }

  // ── Single-model path ──

  if (dryRun) {
    const formatDesc = selectedModel.modelFormat === 'anthropic'
      ? 'direct passthrough'
      : 'via SDK adapter proxy';
    const endpoint = selectedModel.modelFormat === 'anthropic'
      ? (selectedModel.baseUrl ?? '(unknown)')
      : (selectedModel.npm ?? 'SDK');
    console.log('');
    console.log(pc.bold(pc.cyan('  DRY RUN — would execute:')));
    console.log('');
    console.log(`  ${pc.bold('Provider:')}  ${activeProvider.name}`);
    console.log(`  ${pc.bold('Model:')}     ${selectedModel.id}`);
    console.log(`  ${pc.bold('Format:')}    ${selectedModel.modelFormat} (${formatDesc})`);
    console.log(`  ${pc.bold(selectedModel.modelFormat === 'anthropic' ? 'Endpoint:' : 'SDK npm:')} ${endpoint}`);
    console.log(`  ${pc.bold('Key:')}       ${activeProvider.name} provider key`);
    if (parsed.fast) console.log(`  ${pc.bold('Processing:')} Fast requested (OpenAI OAuth routes only)`);
    console.log('');
    console.log(pc.dim('  (dry run complete — Claude Code was NOT launched)'));
    console.log('');
    return 0;
  }

  const launchApiKey = await resolveLocalProviderApiKey(activeProvider);
  const anonymousProvider = activeProvider.authType === 'none';
  if (!anonymousProvider && !launchApiKey?.trim()) {
    p.log.error(
      `No credential found for ${activeProvider.name}. Add a key or sign in with clodex providers.`,
    );
    return 1;
  }

  let proxyHandle: ProxyHandle | null = null;
  let childEnv: NodeJS.ProcessEnv;

  const isOAuthAnthropic = selectedModel.modelFormat === 'anthropic' && activeProvider.authType === 'oauth';
  const usesAnthropicProxy = selectedModel.modelFormat === 'anthropic' &&
    (isOAuthAnthropic || anonymousProvider);

  // Static provider headers remain part of the proxied endpoint contract,
  // including OAuth routes. Anonymous dispatch filters credential-bearing
  // names at the final boundary while retaining non-credential metadata.
  if (usesAnthropicProxy) {
    // The passthrough proxy owns upstream authentication for OAuth and strips it
    // entirely for explicitly anonymous Anthropic endpoints.
    try {
      proxyHandle = await startProxy(
        selectedModel.baseUrl ?? 'https://api.anthropic.com',
        selectedModel.id,
        trace,
        selectedModel.contextWindow,
        {
          providerId: activeProvider.id,
          authType: activeProvider.authType,
          oauthAccountId: activeProvider.oauthAccountId,
          providerData: activeProvider.providerData,
          modelFormat: 'anthropic',
          headers: activeProvider.headers,
        },
        launchApiKey ?? '',
      );
      if (!isAgentStdoutMode()) p.log.info(`Anthropic proxy started on port ${proxyHandle.port}`);
    } catch (err) {
      p.log.error(`Failed to start Anthropic proxy: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    childEnv = buildChildEnv(
      `http://127.0.0.1:${proxyHandle.port}`,
      selectedModel.id,
      proxyHandle.token,
      proxyHandle.port,
      selectedModel.contextWindow,
      false,
    );
  } else if (selectedModel.modelFormat === 'anthropic') {
    childEnv = buildChildEnv(
      selectedModel.baseUrl!,
      selectedModel.id,
      launchApiKey ?? '',
      undefined,
      selectedModel.contextWindow,
      false,
    );
  } else {
    try {
      proxyHandle = await startProxy(
        selectedModel.completionsUrl ?? '',
        selectedModel.id,
        trace,
        selectedModel.contextWindow,
        {
          npm: selectedModel.npm,
          baseURL: selectedModel.apiBaseUrl,
          upstreamModelId: selectedModel.upstreamModelId,
          providerId: activeProvider.id,
          authType: activeProvider.authType,
          oauthAccountId: activeProvider.oauthAccountId,
          supportedParameters: selectedModel.supportedParameters,
          reasoning: selectedModel.reasoning,
          interleavedReasoningField: selectedModel.interleavedReasoningField,
          useResponsesLite: selectedModel.useResponsesLite,
          processingMode: parsed.fast
            && activeProvider.id === 'openai-oauth'
            && activeProvider.authType === 'oauth'
            ? 'fast'
            : undefined,
          headers: activeProvider.headers,
        },
        launchApiKey ?? '',
      );
      if (!isAgentStdoutMode()) {
        p.log.info(
          `SDK adapter proxy started on port ${proxyHandle.port}` +
          (selectedModel.npm ? pc.dim(` (${selectedModel.npm})`) : ''),
        );
      }
    } catch (err) {
      p.log.error(`Failed to start SDK adapter proxy: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    childEnv = buildChildEnv(
      `http://127.0.0.1:${proxyHandle.port}`,
      selectedModel.id,
      proxyHandle.token,
      proxyHandle.port,
      selectedModel.contextWindow,
      true,
      activeProvider.id === 'openai-oauth',
    );
  }

  if (selectedModel.modelFormat === 'anthropic' && !usesAnthropicProxy) {
    childEnv['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'] = '1';
  }
  if (parsed.fast) childEnv['CLODEX_CLAUDE_FAST_DEFAULT'] = '1';

  const debugLogPath = prepareClaudeTraceLog();
  const traceArgs = trace ? ['--debug-file', debugLogPath] : [];
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);

  const exitCode = await launchClaude(
    childEnv,
    claudeCodeClientModelId(selectedModel.id, selectedModel.contextWindow),
    [...traceArgs, ...claudeArgs],
  );
  await proxyHandle?.close();
  if (trace) printTraceLog(debugLogPath);
  return exitCode;
}
