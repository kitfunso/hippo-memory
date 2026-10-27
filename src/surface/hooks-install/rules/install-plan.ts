// What every hook installer shares: the hook timeouts, the empty result and the hooks-object guard.

import { type JsonHookTarget } from './shared.js';
import { type JsonValue, isJsonObjectLiteral, type JsonObject } from '../../../base/util/json.js';
import type { InstallResult } from './json-hooks.js';

// Hook timeouts by cost: a local read or write, a short store lookup, a pass that may compact.
export const HOOK_SHORT_TIMEOUT_SECONDS = 5;

export const HOOK_MEDIUM_TIMEOUT_SECONDS = 10;

export const HOOK_LONG_TIMEOUT_SECONDS = 30;

export function nothingInstalled(target: JsonHookTarget, settingsPath: string): InstallResult {
  return {
    target,
    settingsPath,
    installedSessionEnd: false,
    installedSessionStart: false,
    installedUserPromptSubmit: false,
    installedPreCompact: false,
    installedCompactResume: false,
    installedPostCompact: false,
    installedCaptureError: false,
    migratedPinnedInjectRecent: false,
    migratedFromStop: false,
    migratedLegacySessionEnd: false,
    migratedSplitSessionEnd: false,
    invalidJson: false,
  };
}

/** Assigns `settings.hooks = {}` when it is absent, then returns it if it is an object whose
 * `events`, where present, are arrays; null when appending would overwrite anything else. */
export function ensureHooksObject(
  settings: JsonObject,
  events: readonly string[],
): JsonObject | null {
  if (settings.hooks === undefined) settings.hooks = {};
  const hooks = settings.hooks;
  if (!isJsonObjectLiteral(hooks)) return null;
  if (events.some((e) => hooks[e] !== undefined && !Array.isArray(hooks[e]))) return null;
  return hooks;
}

/** What an install does to one settings file: the result to report, and the settings to write,
 * null when the file stays as it is. */
export interface HookInstallPlan {
  readonly result: InstallResult;
  readonly write: JsonValue | null;
}
