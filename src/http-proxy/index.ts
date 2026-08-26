import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadPreferences } from '../config/config.js';
import { DEFAULT_SERVER_PORT } from '../constants.js';
import { fetchProviderCatalog, resolveLocalProviderApiKey } from '../models/provider-catalog.js';
import { providersForTarget } from '../models/target-compatibility.js';
import type { ProxyHandle, ProxyRoute, ProxyRouteRequestResolver } from '../proxy/index.js';
import { buildHttpProxyRoutes, type HttpProxyRouteResult } from './routes.js';
import { startHttpProxy, type HttpProxyHandle, type HttpProxyOptions } from './server.js';
import { ensureHttpProxyCaBundle } from './ca.js';
import { registerServerRuntimeState, unregisterServerRuntimeState } from '../runtime/server-runtime.js';
import {
  getInferenceRequestLogPath,
  getSessionLogPath,
  writeProxyLifecycleLog,
} from '../observability/trace-log.js';
import { removeAnthropicProxyBypass } from '../runtime/wrapper-env.js';
import {
  canonicalModelAliasName,
  describeModelAliasRejection,
  normalizeModelAliases,
} from '../models/aliases.js';
import type { ProxyModelAlias } from '../proxy/index.js';

export interface LoadedHttpProxyRoutes extends HttpProxyRouteResult {
  favoriteCount: number;
}

function contextLabel(contextWindow: number | undefined): string {
  if (!contextWindow || contextWindow <= 0) return '';
  const scaled = contextWindow >= 1_000_000
    ? `${Number((contextWindow / 1_000_000).toFixed(2))}M`
    : contextWindow >= 1_000
      ? `${Number((contextWindow / 1_000).toFixed(1))}K`
      : String(contextWindow);
  return ` (${scaled} context)`;
}

export async function loadHttpProxyRoutes(): Promise<LoadedHttpProxyRoutes> {
  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const normalizedAliases = normalizeModelAliases(prefs.modelAliases);
  if (favorites.length === 0) {
    return {
      routes: [],
      unavailable: [],
      unsupported: [],
      aliases: [],
      unavailableAliases: [
        ...normalizedAliases.rejected,
        ...normalizedAliases.accepted.flatMap(({ sources }) => sources),
      ],
      favoriteCount: 0,
    };
  }
  const rawCatalog = providersForTarget(await fetchProviderCatalog({ agent: 'claude' }), 'claude');
  const catalog = await Promise.all(rawCatalog.map(async provider => Object.assign({}, provider, {
    apiKey: (await resolveLocalProviderApiKey(provider)) ?? '',
  })));
  return {
    ...buildHttpProxyRoutes(catalog, favorites, prefs.modelAliases),
    favoriteCount: favorites.length,
  };
}

/** Include inactive saved aliases so they fail closed instead of selecting the default route. */
export function liveProxyModelAliases(
  loaded: LoadedHttpProxyRoutes,
): ProxyModelAlias[] {
  const inactive = normalizeModelAliases(loaded.unavailableAliases);
  return [
    ...loaded.aliases,
    ...inactive.accepted.map(({ alias, source, sources }) => {
      const entry: ProxyModelAlias = {
        name: alias.name,
        unavailableReason: 'target unavailable',
      };
      if (source.name !== alias.name) entry.savedName = source.name;
      if (sources.length !== 1 || sources[0]!.name !== alias.name) {
        entry.sourceNames = [...new Set(sources.map(sourceEntry => sourceEntry.name))];
      }
      return entry;
    }),
    ...inactive.rejections.map(rejection => {
      const name = canonicalModelAliasName(rejection.alias.name);
      const entry: ProxyModelAlias = {
        name,
        unavailableReason: describeModelAliasRejection(rejection.reason),
      };
      if (rejection.alias.name !== name) entry.savedName = rejection.alias.name;
      return entry;
    }),
  ];
}

export function formatHttpProxyModelLines(
  routes: ProxyRoute[],
  aliases: LoadedHttpProxyRoutes['aliases'] = [],
): string[] {
  if (routes.length === 0) return ['  (no compatible favorite models)'];
  const routesById = new Map(routes.map(route => [route.aliasId, route]));
  return [
    ...aliases.map(alias => {
      const route = routesById.get(alias.routeId);
      return `  ${alias.name}  ${pc.dim(`${alias.displayName}${contextLabel(route?.contextWindow)} → ${alias.routeId}`)}`;
    }),
    ...routes.map(route => `  ${route.aliasId}  ${pc.dim(`${route.displayName}${contextLabel(route.contextWindow)}`)}`),
  ];
}

export function printHttpProxyModels(
  routes: ProxyRoute[],
  aliases: LoadedHttpProxyRoutes['aliases'] = [],
): void {
  console.log(pc.bold('HTTP proxy model names:'));
  for (const line of formatHttpProxyModelLines(routes, aliases)) console.log(line);
}

export function reportSkippedHttpProxyFavorites(loaded: LoadedHttpProxyRoutes): void {
  if (loaded.unavailable.length > 0) {
    p.log.warn(`${loaded.unavailable.length} favorite${loaded.unavailable.length === 1 ? '' : 's'} unavailable or missing credentials.`);
  }
  if (loaded.unsupported.length > 0) {
    p.log.warn(
      `${loaded.unsupported.length} favorite${loaded.unsupported.length === 1 ? '' : 's'} skipped — `
      + 'HTTP proxy mode supports non-Anthropic AI SDK routes only.',
    );
  }
  if (loaded.unavailableAliases.length > 0) {
    const normalizedAliases = normalizeModelAliases(loaded.unavailableAliases);
    const reasonByAlias = new Map(
      normalizedAliases.rejections.map(rejection => [
        rejection.alias,
        describeModelAliasRejection(rejection.reason),
      ]),
    );
    p.log.warn(
      `${loaded.unavailableAliases.length} model alias${loaded.unavailableAliases.length === 1 ? '' : 'es'} skipped. `
      + 'Saved entries were preserved.\n'
      + loaded.unavailableAliases
        .map(alias => `  ${JSON.stringify(alias.name)} — ${reasonByAlias.get(alias) ?? 'target unavailable'}`)
        .join('\n'),
    );
  }
}

export function buildConfiguredHttpProxyOptions(
  loaded: LoadedHttpProxyRoutes,
  port: number,
  debug = false,
  inferenceLogPath = getInferenceRequestLogPath(),
  debugLogPath?: string,
  webSocketDiagnosticsLogPath?: string,
  resolveRouteForRequest?: ProxyRouteRequestResolver,
  adapterHandle?: ProxyHandle,
  optimizeTranslatedRequest?: HttpProxyOptions['optimizeTranslatedRequest'],
): HttpProxyOptions {
  return {
    host: '127.0.0.1',
    port,
    routes: loaded.routes,
    modelAliases: loaded.aliases,
    reservedModelIds: [...new Set([
      ...loaded.aliases.flatMap(alias => alias.sourceNames ?? []),
      ...loaded.unavailableAliases.map(alias => alias.name),
    ].flatMap(name => {
      const trimmedName = name.trim();
      const canonicalName = canonicalModelAliasName(name);
      return [name, trimmedName, canonicalName].filter(Boolean);
    }))],
    debug,
    debugLogPath,
    inferenceLogPath,
    webSocketDiagnosticsLogPath,
    resolveRouteForRequest,
    adapterHandle,
    optimizeTranslatedRequest,
  };
}

export function formatHttpProxyEnvironmentLines(
  handle: Pick<HttpProxyHandle, 'port' | 'caCertPath'>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const env = { ...baseEnv };
  const hadNoProxy = env['NO_PROXY'] !== undefined || env['no_proxy'] !== undefined;
  removeAnthropicProxyBypass(env);
  return [
    `  HTTPS_PROXY=http://127.0.0.1:${handle.port}`,
    `  HTTP_PROXY=http://127.0.0.1:${handle.port}`,
    `  NODE_EXTRA_CA_CERTS=${handle.caCertPath}`,
    ...(hadNoProxy
      ? [`  NO_PROXY=${env['NO_PROXY'] ?? ''}`, `  no_proxy=${env['no_proxy'] ?? ''}`]
      : []),
  ];
}

async function startConfiguredHttpProxy(
  port: number,
  debug = false,
  inferenceLogPath = getInferenceRequestLogPath(),
  debugLogPath?: string,
  webSocketDiagnosticsLogPath?: string,
  resolveRouteForRequest?: ProxyRouteRequestResolver,
  adapterHandle?: ProxyHandle,
  optimizeTranslatedRequest?: HttpProxyOptions['optimizeTranslatedRequest'],
): Promise<{ handle: HttpProxyHandle; loaded: LoadedHttpProxyRoutes }> {
  const loaded = await loadHttpProxyRoutes();
  const handle = await startHttpProxy(buildConfiguredHttpProxyOptions(
    loaded,
    port,
    debug,
    inferenceLogPath,
    debugLogPath,
    webSocketDiagnosticsLogPath,
    resolveRouteForRequest,
    adapterHandle,
    optimizeTranslatedRequest,
  ));
  handle.caCertPath = ensureHttpProxyCaBundle(
    handle.caCertPath,
    process.env['NODE_EXTRA_CA_CERTS'],
  );
  return { handle, loaded };
}

function waitForShutdown(): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

export async function runHttpProxyServerCommand(
  debug = false,
  webSocketDiagnostics = false,
  port?: number,
  noDiscovery = false,
  shutdownSignal?: Promise<void>,
): Promise<number> {
  const webSocketDiagnosticsLogPath = webSocketDiagnostics
    ? getSessionLogPath('server-websocket-diagnostics', 'jsonl')
    : undefined;
  const inferenceLogPath = getInferenceRequestLogPath();
  let started: Awaited<ReturnType<typeof startConfiguredHttpProxy>>;
  try {
    started = await startConfiguredHttpProxy(
      port ?? DEFAULT_SERVER_PORT,
      debug,
      inferenceLogPath,
      undefined,
      webSocketDiagnosticsLogPath,
    );
  } catch (err) {
    p.log.error(`Failed to start HTTP proxy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { handle, loaded } = started;
  writeProxyLifecycleLog(inferenceLogPath, {
    event: 'proxy_started',
    pid: process.pid,
    parentPid: process.ppid,
    host: handle.host,
    port: handle.port,
  });
  console.log('');
  console.log(pc.bold(pc.green('clodex proxy-mode server running')));
  for (const line of formatHttpProxyEnvironmentLines(handle)) console.log(line);
  console.log(`  Request log: ${handle.inferenceLogPath}`);
  if (handle.webSocketDiagnosticsLogPath) {
    console.log(`  WebSocket diagnostics: ${handle.webSocketDiagnosticsLogPath}`);
    console.log(pc.yellow('  Diagnostic mode records request headers and metadata; credential headers are redacted.'));
  }
  console.log('');
  printHttpProxyModels(loaded.routes, loaded.aliases);
  reportSkippedHttpProxyFavorites(loaded);
  console.log('');
  console.log(pc.dim('Anthropic requests keep Claude Code auth and pass through unchanged.'));
  console.log(pc.dim('Use `/model <listed-name>` for a favorite or saved alias.'));
  console.log(pc.dim('Press Ctrl+C to stop.'));

  // Advertise the standalone server for discovery (e.g. by generic wrappers).
  // Plain Claude Code uses the persistent daemon endpoint instead. --no-discovery
  // / CLODEX_NO_DISCOVERY opts this standalone server out.
  if (!noDiscovery) {
    registerServerRuntimeState({
      mode: 'proxy',
      port: handle.port,
      pid: process.pid,
      caPath: handle.caCertPath,
      startedAt: new Date().toISOString(),
    });
  }

  await (shutdownSignal ?? waitForShutdown());
  writeProxyLifecycleLog(inferenceLogPath, {
    event: 'proxy_stopping',
    pid: process.pid,
    parentPid: process.ppid,
    host: handle.host,
    port: handle.port,
    reason: 'shutdown signal received',
  });
  if (!noDiscovery) unregisterServerRuntimeState();
  await handle.close();
  writeProxyLifecycleLog(inferenceLogPath, {
    event: 'proxy_stopped',
    pid: process.pid,
    parentPid: process.ppid,
    host: handle.host,
    port: handle.port,
  });
  return 0;
}
