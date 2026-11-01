/** Hook install and removal rules for AI coding tools, on parsed settings: Claude Code gets a
 * JSON `hooks` block in settings.json with older forms migrated, Codex an appended one, Copilot
 * a whole file; surface/hooks-install does the reads and writes. */

import * as path from 'node:path';
import { type JsonHookTarget, copilotHooksFile } from './shared.js';
import {
  HIPPO_DIR,
  claudeConfigDir,
  codexHomeDir,
  userHome,
  type Homes,
} from '../../../base/util/agent-homes.js';
import { type JsonValue, isJsonObjectLiteral, type JsonObject } from '../../../base/util/json.js';
import {
  keptHippoHandlers,
  planClaudeCodeHooks,
  uninstallClaudeCodeHooks,
} from './claude-hooks.js';
import { planCodexHooks, uninstallCodexHooks } from './codex-hooks.js';
import { nothingInstalled, type HookInstallPlan } from './install-plan.js';
import { copilotHooksTable } from './copilot.js';

/** A target's hook settings file, the log its SessionEnd hook writes, and the tool's
 * display name. */
export interface JsonHookPaths {
  settings: string;
  logFile: string;
  display: string;
}

/** What installJsonHooks wrote, migrated or left alone in one target's settings file. */
export interface InstallResult {
  target: JsonHookTarget;
  settingsPath: string;
  installedSessionEnd: boolean;
  installedSessionStart: boolean;
  installedUserPromptSubmit: boolean;
  installedPreCompact: boolean;
  installedCompactResume: boolean;
  /** PostCompact -> `hippo post-compact` (saves the summary's memories, tells the user
   * how many). */
  installedPostCompact: boolean;
  /** PostToolUseFailure -> `hippo capture-error` (failed tool calls become error memories). */
  installedCaptureError: boolean;
  migratedPinnedInjectRecent: boolean;
  migratedFromStop: boolean;
  migratedLegacySessionEnd: boolean;
  migratedSplitSessionEnd: boolean;
  /** The file exists but is not JSON hippo can merge into, so it was left untouched. */
  invalidJson: boolean;
}

/** The paths for `target` under the machine's home folder; reads and writes nothing. */
export function jsonHookPathsOn(target: JsonHookTarget, homes: Homes): JsonHookPaths {
  const home = userHome(homes);
  const logsDir = path.join(home, HIPPO_DIR, 'logs');
  switch (target) {
    case 'claude-code':
      return {
        settings: path.join(claudeConfigDir(homes.home, homes.env), 'settings.json'),
        logFile: path.join(logsDir, 'claude-code-sleep.log'),
        display: 'Claude Code',
      };
    case 'codex':
      return {
        settings: path.join(codexHomeDir(home, homes.env), 'hooks.json'),
        logFile: path.join(logsDir, 'codex-sleep.log'),
        display: 'Codex',
      };
    case 'copilot':
      return {
        settings: copilotHooksFile(homes),
        logFile: path.join(logsDir, 'copilot-sleep.log'),
        display: 'Copilot',
      };
  }
}

/** A settings file's text as hippo writes it, so an install can tell an unchanged file from one
 * it must write. */
export function settingsText(settings: JsonValue): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Hippo owns this whole file, so install writes the full table and a second install changes
 * no byte. */
export function planCopilotHooks(settingsPath: string, current: string | null): HookInstallPlan {
  const result = nothingInstalled('copilot', settingsPath);
  const table = copilotHooksTable();
  if (current === settingsText(table)) return { result, write: null };
  return {
    result: {
      ...result,
      installedSessionStart: true,
      installedCaptureError: true,
      installedPreCompact: true,
      installedSessionEnd: true,
    },
    write: table,
  };
}

/** Adds hippo's hooks to parsed settings, which it edits in place, and migrates older hippo
 * entries; `settings` is undefined for a file that is not JSON, which stays untouched.
 * `compactLog` is where the compaction hooks log. */
export function planJsonHooks(
  target: 'claude-code' | 'codex',
  paths: Pick<JsonHookPaths, 'settings' | 'logFile'>,
  settings: JsonValue | undefined,
  compactLog: string,
): HookInstallPlan {
  const invalid = {
    result: { ...nothingInstalled(target, paths.settings), invalidJson: true },
    write: null,
  };
  if (settings === undefined) return invalid;
  if (target === 'codex') return planCodexHooks(paths.settings, settings);
  if (!isJsonObjectLiteral(settings)) return invalid;
  return planClaudeCodeHooks(settings, {
    settingsPath: paths.settings,
    logFile: paths.logFile,
    compactLog,
  });
}

/** What uninstall does to parsed settings, edited in place: the settings to write (null when
 * nothing changed) and, for Claude Code, the kept handlers that still name a hippo command. */
export interface HookRemovalPlan {
  readonly write: JsonObject | null;
  readonly kept: readonly string[];
}

/** Removes hippo's own hook handlers and keeps every other handler. */
export function planHookRemoval(
  target: 'claude-code' | 'codex',
  settings: JsonValue,
): HookRemovalPlan {
  if (!isJsonObjectLiteral(settings) || !isJsonObjectLiteral(settings.hooks)) {
    return { write: null, kept: [] };
  }
  const hooks = settings.hooks;
  const changed = target === 'codex' ? uninstallCodexHooks(hooks) : uninstallClaudeCodeHooks(hooks);
  const kept = target === 'claude-code' ? keptHippoHandlers(hooks) : [];
  if (!changed) return { write: null, kept };
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return { write: settings, kept };
}

/** False for settings uninstall cannot edit: not a JSON object (undefined when the text did not
 * parse), or a `hooks` that is not one. */
export function canEditHooks(settings: JsonValue | undefined): boolean {
  return (
    isJsonObjectLiteral(settings) &&
    (settings.hooks === undefined || isJsonObjectLiteral(settings.hooks))
  );
}
