import { normalizeRouteLookupId } from '../models/context-model-id.js';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isObject, isString } from './type-guards.js';

type ClaudeSettingValue = string | number | boolean | null | ClaudeSettingValue[] | ClaudeSettings;

interface ClaudeSettings {
  [key: string]: ClaudeSettingValue;
}

interface ModelPickerRoute {
  aliasId: string;
  displayName: string;
}

interface ModelPickerAlias {
  name: string;
  routeId?: string;
  unavailableReason?: string;
}

export interface ClaudeModelPickerOption {
  model: string;
  label: string;
  description: string;
}

export function buildClaudeModelPickerOptions(
  routes: readonly ModelPickerRoute[],
  aliases: readonly ModelPickerAlias[],
): ClaudeModelPickerOption[] {
  const routesById = new Map(
    routes.map(route => [normalizeRouteLookupId(route.aliasId), route]),
  );
  const representedRoutes = new Set<string>();
  const options: ClaudeModelPickerOption[] = [];

  for (const alias of aliases) {
    if (alias.unavailableReason || !alias.routeId) continue;
    const routeKey = normalizeRouteLookupId(alias.routeId);
    const route = routesById.get(routeKey);
    if (!route || representedRoutes.has(routeKey)) continue;
    representedRoutes.add(routeKey);
    options.push({ model: alias.name, label: alias.name, description: route.displayName });
  }

  for (const route of routes) {
    const routeKey = normalizeRouteLookupId(route.aliasId);
    if (representedRoutes.has(routeKey)) continue;
    representedRoutes.add(routeKey);
    options.push({
      model: route.aliasId,
      label: route.displayName,
      description: route.aliasId,
    });
  }

  return options;
}

function readClaudeSettings(path: string): ClaudeSettings {
  try {
    const parsed: ClaudeSettingValue = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(parsed) || Array.isArray(parsed)) {
      throw new TypeError('the root value must be an object');
    }
    return parsed;
  } catch (error) {
    // SAFETY: Node filesystem errors expose an optional string code.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `Could not read Claude settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function existingFileMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

function getClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

export function readClaudeDefaultModel(path = getClaudeSettingsPath()): string | undefined {
  const model = readClaudeSettings(path)['model'];
  return isString(model) && model.trim() ? model.trim() : undefined;
}

/** Store Clodex picker rows in Claude's native user settings without changing other keys. */
export function syncClaudeModelPickerSettings(
  routes: readonly ModelPickerRoute[],
  aliases: readonly ModelPickerAlias[],
  path = getClaudeSettingsPath(),
): boolean {
  const options = buildClaudeModelPickerOptions(routes, aliases);
  if (options.length === 0) return false;
  const current = readClaudeSettings(path);
  const picker = current['modelPicker'];
  const currentPicker = isObject(picker) && !Array.isArray(picker)
    ? picker
    : {};
  const next = {
    ...current,
    modelPicker: { ...currentPicker, options },
  };
  const currentText = `${JSON.stringify(current, null, 2)}\n`;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (currentText === nextText) return false;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, nextText, { mode: existingFileMode(path) });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was not created or was already renamed.
    }
    throw error;
  }
  return true;
}
