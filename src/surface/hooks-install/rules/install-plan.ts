// What every hook installer shares: the hook timeouts, the empty result and the hooks-object guard.

import { type JsonHookTarget } from './shared.js';
import { type JsonValue, isJsonObjectLiteral, type JsonObject } from '../../../base/util/json.js';
import { hookArrayContains } from './hook-handlers.js';
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
    installedSessionRules: false,
    installedUserPromptSubmit: false,
    installedPreCompact: false,
    installedCompactResume: false,
    installedPostCompact: false,
    installedCaptureError: false,
    installedNoteWritten: false,
    installedEndCheck: false,
    migratedPinnedInjectRecent: false,
    migratedFromStop: false,
    migratedLegacySessionEnd: false,
    migratedSplitSessionEnd: false,
    leftOut: [],
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

/** What an install does to one settings file: the result to report, the settings to write (null
 * when the file stays as it is) and the markers of the hippo hooks the file holds afterwards. */
export interface HookInstallPlan {
  readonly result: InstallResult;
  readonly write: JsonValue | null;
  readonly present: readonly string[];
}

export interface HookInstallOptions {
  readonly endCheck?: boolean;
}

export type AppendHook = (event: string, marker: string, group: JsonObject) => boolean;

interface HookAppender {
  readonly append: AppendHook;
  readonly present: readonly string[];
  readonly leftOut: readonly string[];
}

/** Adds each hook the file lacks, except one the user removed after an earlier install (its marker
 * is in `recorded`); `present` and `leftOut` fill as the plan runs. */
export function hookAppender(hooks: JsonObject, recorded: ReadonlySet<string>): HookAppender {
  const present: string[] = [];
  const leftOut: string[] = [];
  const append: AppendHook = (event, marker, group) => {
    const groups = hooks[event];
    if (hookArrayContains(groups, marker)) {
      present.push(marker);
      return false;
    }
    if (recorded.has(marker)) {
      leftOut.push(marker);
      return false;
    }
    hooks[event] = [...(Array.isArray(groups) ? groups : []), group];
    present.push(marker);
    return true;
  };
  return { append, present, leftOut };
}
