import pc from 'picocolors';
import * as p from '@clack/prompts';
import { launchClaude } from '../runtime/launch.js';
import { buildChildEnv } from '../config/environment.js';
import { claudeCodeClientModelId } from '../models/context-model-id.js';
import { startProxyCatalog } from '../proxy/index.js';
import type { ProxyHandle, ProxyModelAlias, ProxyRoute } from '../proxy/index.js';
import {
  prepareClaudeTraceLog,
  printTraceLog,
} from '../observability/trace-log.js';
import { resolveOpenAiCompactionThreshold } from '../oauth/responses-compaction.js';
import { syncClaudeModelPickerSettings } from '../runtime/claude-settings.js';

export function reportInactiveCatalogAliases(modelAliases: ProxyModelAlias[]): void {
  const unavailableAliases = modelAliases.filter(alias => alias.unavailableReason !== undefined);
  if (unavailableAliases.length === 0) return;
  const warningLines = unavailableAliases.flatMap(alias => (
    alias.sourceNames?.length
      ? alias.sourceNames.map(name => (
          `  ${JSON.stringify(name)} — ${alias.unavailableReason}`
        ))
      : [
          `  ${JSON.stringify(alias.savedName ?? alias.name)} — ${alias.unavailableReason}`,
        ]
  ));

  p.log.warn(
    `${warningLines.length} saved model alias${warningLines.length === 1 ? '' : 'es'} inactive. `
    + 'Saved entries were preserved.\n'
    + warningLines.join('\n'),
  );
}

export function catalogUsesClodexCompaction(
  catalogRoutes: Array<Pick<ProxyRoute, 'providerId' | 'modelFormat' | 'contextWindow'>>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return catalogRoutes.length > 0 && catalogRoutes.every(route =>
    route.providerId === 'openai-oauth'
    && route.modelFormat === 'openai'
    && resolveOpenAiCompactionThreshold(route.contextWindow, env) !== undefined);
}

export async function launchClaudeViaCatalog(
  catalogRoutes: ProxyRoute[],
  startingRoute: ProxyRoute,
  modelAliases: ProxyModelAlias[],
  contextWindow: number | undefined,
  trace: boolean,
  claudeArgs: string[],
  fastByDefault = false,
): Promise<number> {
  reportInactiveCatalogAliases(modelAliases);
  const launchRoutes = fastByDefault
    ? catalogRoutes.map(route => route.providerId === 'openai-oauth' && route.authType === 'oauth'
      ? { ...route, processingMode: 'fast' as const }
      : route)
    : catalogRoutes;
  try {
    syncClaudeModelPickerSettings(launchRoutes, modelAliases);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let proxyHandle: ProxyHandle;
  try {
    proxyHandle = await startProxyCatalog(
      launchRoutes,
      startingRoute.aliasId,
      trace,
      undefined,
      undefined,
      undefined,
      modelAliases,
    );
    p.log.info(
      `Switch menu active — proxy on port ${proxyHandle.port} ` +
      pc.dim(`(${catalogRoutes.length} model${catalogRoutes.length !== 1 ? 's' : ''} in /model)`),
    );
  } catch (err) {
    p.log.error(`Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const childEnv = buildChildEnv(
    `http://127.0.0.1:${proxyHandle.port}`,
    startingRoute.aliasId,
    proxyHandle.token,
    proxyHandle.port,
    contextWindow,
    true,
    // The ownership flag is process-wide while /model can switch routes.
    // Suppress Claude's compactor only when every selectable route is covered
    // by Clodex native compaction; mixed catalogs must keep Claude's lifecycle.
    catalogUsesClodexCompaction(catalogRoutes),
  );
  const debugLogPath = prepareClaudeTraceLog();
  const traceArgs = trace ? ['--debug-file', debugLogPath] : [];
  if (trace) p.log.info(`Debug log: ${debugLogPath}`);

  const exitCode = await launchClaude(
    childEnv,
    claudeCodeClientModelId(startingRoute.aliasId, contextWindow),
    [...traceArgs, ...claudeArgs],
  );
  await proxyHandle.close();
  if (trace) printTraceLog(debugLogPath);
  return exitCode;
}
