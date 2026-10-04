/**
 * Hook install/uninstall for AI coding tools.
 *
 * Two integration models live in this file:
 *
 * 1. JSON-hook install (Claude Code only). Writes a `hooks` block into the
 *    tool's settings.json with two entries:
 *      - SessionEnd: `hippo session-end --log-file <path>` - spawns a detached
 *        child that runs `hippo sleep` then `hippo capture --last-session` in
 *        sequence, writing both outputs to the log file. The parent returns in
 *        <100ms so the TUI teardown can't kill the child before it finishes.
 *      - SessionStart: `hippo last-sleep --path <path>` - prints the log
 *        written by the previous session's detached worker to stderr, which
 *        keeps it out of the model's context, and then clears it.
 *    Earlier Claude Code forms are detected and migrated automatically:
 *      - < 0.20.2: `Stop` hook firing `hippo sleep` on every assistant turn.
 *      - < 0.21.0: bare `hippo sleep` in SessionEnd, no `--log-file`.
 *      - 0.22.x: separate sleep + capture SessionEnd entries.
 *    PreCompact and PostCompact entries go in too: the first records the compaction and
 *    asks the summariser for a "Memories for hippo" list, the second saves that list.
 *    Codex's hooks.json gets only two groups (per-prompt memory and
 *    compact-resume); see installCodexHooks.
 *
 * 2. Plugin install (OpenCode only). OpenCode does NOT share Claude Code's
 *    JSON-hook schema — its config has `additionalProperties: false` and no
 *    `hooks` key, so a JSON-hook install breaks opencode launch. Hippo
 *    installs a TypeScript plugin at
 *    `~/.config/opencode/plugins/hippo.ts` subscribing to opencode's
 *    `session.idle` (→ `hippo session-end`) and `session.created` (→
 *    `hippo last-sleep`) events. See OPENCODE_PLUGIN_SOURCE below for the
 *    plugin file content + design rationale; see installOpencodePlugin for
 *    the installer + the migration that removes any pre-existing broken
 *    `hooks` block from opencode.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { JsonObject } from '../working-memory.js';
import { isJsonObject, type JsonHookTarget, HIPPO_SLEEP_MARKER, HIPPO_LAST_SLEEP_MARKER, HIPPO_CAPTURE_MARKER, HIPPO_SESSION_END_MARKER, HIPPO_PINNED_INJECT_MARKER, HIPPO_PINNED_INJECT_COMMAND, HIPPO_PRE_COMPACT_MARKER, HIPPO_COMPACT_RESUME_MARKER, HIPPO_CAPTURE_ERROR_MARKER, HIPPO_POST_COMPACT_MARKER, homeDir, codexHomeDir, defaultPreCompactLogPath } from './shared.js';
import { type JsonValue, isJsonString } from '../json.js';

export interface JsonHookPaths {
  settings: string;
  logFile: string;
  display: string;
}

export interface InstallResult {
  target: JsonHookTarget;
  settingsPath: string;
  installedSessionEnd: boolean;
  installedSessionStart: boolean;
  installedUserPromptSubmit: boolean;
  installedPreCompact: boolean;
  installedCompactResume: boolean;
  /** PostCompact -> `hippo post-compact` (saves the summary's memories, tells the user how many). */
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

export function resolveJsonHookPaths(target: JsonHookTarget): JsonHookPaths {
  const home = homeDir();
  const logsDir = path.join(home, '.hippo', 'logs');
  switch (target) {
    case 'claude-code':
      return {
        settings: path.join(home, '.claude', 'settings.json'),
        logFile: path.join(logsDir, 'claude-code-sleep.log'),
        display: 'Claude Code',
      };
    case 'codex':
      return {
        settings: path.join(codexHomeDir(home), 'hooks.json'),
        logFile: path.join(logsDir, 'codex-sleep.log'),
        display: 'Codex',
      };
  }
}

function hookArrayContains(hookArray: JsonValue | undefined, marker: string): boolean {
  if (!Array.isArray(hookArray)) return false;
  return JSON.stringify(hookArray).includes(marker);
}

function addIncludeRecentToPinnedCommand(command: string): string {
  if (!command.includes(HIPPO_PINNED_INJECT_MARKER) || command.includes('--include-recent')) return command;
  return command.includes(' --format ')
    ? command.replace(' --format ', ' --include-recent 5 --format ')
    : `${command} --include-recent 5`;
}

function migratePinnedInjectRecentCommands(hookArray: JsonValue | undefined): boolean {
  if (!Array.isArray(hookArray)) return false;
  let changed = false;
  for (const entry of hookArray) {
    if (!isJsonObject(entry)) continue;
    const innerHooks = entry.hooks;
    if (!Array.isArray(innerHooks)) continue;
    for (const hook of innerHooks) {
      if (!isJsonObject(hook)) continue;
      if (!isJsonString(hook.command)) continue;
      const next = addIncludeRecentToPinnedCommand(hook.command);
      if (next !== hook.command) {
        hook.command = next;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Returns true when `hooks.SessionEnd` still contains either of the legacy
 * split entries (bare `hippo sleep` / `hippo capture --last-session`)
 * without the current consolidated `hippo session-end` entry.
 */
function hasLegacySplitSessionEnd(hookArray: JsonValue | undefined): boolean {
  if (!Array.isArray(hookArray)) return false;
  const serialized = JSON.stringify(hookArray);
  const hasSleep = serialized.includes(HIPPO_SLEEP_MARKER);
  const hasCapture = serialized.includes(HIPPO_CAPTURE_MARKER);
  return (hasSleep || hasCapture) && !serialized.includes(HIPPO_SESSION_END_MARKER);
}

function nothingInstalled(target: JsonHookTarget, settingsPath: string): InstallResult {
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

/** A command hook with a Windows form: Codex runs hooks in PowerShell there, whose execution policy can block npm's hippo.ps1. */
function codexCommandHook(command: string, timeout: number): JsonObject {
  return { type: 'command', command, commandWindows: command.replace(/^hippo /, 'hippo.cmd '), timeout };
}

/** Codex keys trust to each hook's position and hash and re-asks for a changed one, so hippo only appends and never edits an entry. */
function installCodexHooks(settingsPath: string, settings: JsonValue): InstallResult {
  const result = nothingInstalled('codex', settingsPath);
  if (!isJsonObject(settings)) return { ...result, invalidJson: true };
  if (settings.hooks === undefined) settings.hooks = {};
  const hooks = settings.hooks;
  const events = ['UserPromptSubmit', 'SessionStart'];
  if (!isJsonObject(hooks) || events.some((e) => hooks[e] !== undefined && !Array.isArray(hooks[e]))) {
    return { ...result, invalidJson: true };
  }
  const append = (event: string, marker: string, group: JsonObject): boolean => {
    const groups = hooks[event];
    if (hookArrayContains(groups, marker)) return false;
    hooks[event] = [...(Array.isArray(groups) ? groups : []), group];
    return true;
  };
  const installedUserPromptSubmit = append('UserPromptSubmit', HIPPO_PINNED_INJECT_MARKER, {
    hooks: [codexCommandHook(HIPPO_PINNED_INJECT_COMMAND, 5)],
  });
  const installedCompactResume = append('SessionStart', HIPPO_COMPACT_RESUME_MARKER, {
    matcher: 'compact',
    hooks: [codexCommandHook(HIPPO_COMPACT_RESUME_MARKER, 10)],
  });
  if (installedUserPromptSubmit || installedCompactResume) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return { ...result, installedUserPromptSubmit, installedCompactResume };
}

export function installJsonHooks(target: JsonHookTarget): InstallResult {
  const { settings: settingsPath, logFile } = resolveJsonHookPaths(target);
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let settings: JsonObject = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      return { ...nothingInstalled(target, settingsPath), invalidJson: true };
    }
  }
  if (target === 'codex') return installCodexHooks(settingsPath, settings);
  return installClaudeCodeHooks(settingsPath, settings, logFile);
}

type ClaudeHooks = Record<string, JsonValue[]>;

interface LegacyHookMigration {
  migratedFromStop: boolean;
  migratedLegacySessionEnd: boolean;
  migratedSplitSessionEnd: boolean;
}

function migrateLegacyClaudeHooks(hooks: ClaudeHooks): LegacyHookMigration {
  let migratedFromStop = false;
  if (Array.isArray(hooks.Stop) && hookArrayContains(hooks.Stop, HIPPO_SLEEP_MARKER)) {
    hooks.Stop = hooks.Stop.filter((entry) => !JSON.stringify(entry).includes(HIPPO_SLEEP_MARKER));
    if (hooks.Stop.length === 0) delete hooks.Stop;
    migratedFromStop = true;
  }

  // Migrate legacy SessionEnd forms:
  //   - pre-0.21 bare `hippo sleep`
  //   - 0.21.x+ `hippo sleep --log-file` split across two entries
  //   - 0.22.x `hippo capture --last-session --log-file` second entry
  // All of these get collapsed into the single `hippo session-end` entry.
  let migratedLegacySessionEnd = false;
  let migratedSplitSessionEnd = false;
  if (Array.isArray(hooks.SessionEnd) && hasLegacySplitSessionEnd(hooks.SessionEnd)) {
    const before = hooks.SessionEnd.length;
    hooks.SessionEnd = hooks.SessionEnd.filter((entry) => {
      const s = JSON.stringify(entry);
      return !s.includes(HIPPO_SLEEP_MARKER) && !s.includes(HIPPO_CAPTURE_MARKER);
    });
    if (hooks.SessionEnd.length === 0) delete hooks.SessionEnd;
    // If the removed entries used the log-file pattern (0.21.x-0.22.x) we
    // call it a "split" migration; otherwise it was the older bare form.
    migratedSplitSessionEnd = true;
    migratedLegacySessionEnd = before > 1;
  }
  return { migratedFromStop, migratedLegacySessionEnd, migratedSplitSessionEnd };
}

function claudeCommandGroup(command: string, timeout: number, matcher?: string): JsonObject {
  const hooks = [{ type: 'command', command, timeout }];
  return matcher === undefined ? { hooks } : { matcher, hooks };
}

function appendHookIfMissing(hooks: ClaudeHooks, event: string, marker: string, group: JsonObject): boolean {
  if (hookArrayContains(hooks[event], marker)) return false;
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  hooks[event].push(group);
  return true;
}

function installClaudeCodeHooks(settingsPath: string, settings: JsonObject, logFile: string): InstallResult {
  if (!settings.hooks) settings.hooks = {};
  // SAFETY: settings.hooks is either freshly initialised to {} on the line above, or an
  // existing value from settings.json — Claude Code's own schema always writes an object
  // there; each event key below is still re-validated with Array.isArray before use.
  const hooks = settings.hooks as ClaudeHooks;
  const migration = migrateLegacyClaudeHooks(hooks);

  const installedSessionEnd = appendHookIfMissing(hooks, 'SessionEnd', HIPPO_SESSION_END_MARKER,
    claudeCommandGroup(`hippo session-end --log-file "${logFile}"`, 5));
  const installedSessionStart = appendHookIfMissing(hooks, 'SessionStart', HIPPO_LAST_SLEEP_MARKER,
    claudeCommandGroup(`hippo last-sleep --path "${logFile}"`, 5));

  // Mid-session pinned-rule re-injection: UserPromptSubmit runs every turn,
  // so pinned memories stay in context even after the model would otherwise
  // "forget" them in a long session. Include the fresh write tail so lessons
  // saved earlier in the same session become visible on the next prompt even
  // before the user pins them explicitly.
  const migratedPinnedInjectRecent = migratePinnedInjectRecentCommands(hooks.UserPromptSubmit);
  const installedUserPromptSubmit = appendHookIfMissing(hooks, 'UserPromptSubmit', HIPPO_PINNED_INJECT_MARKER,
    claudeCommandGroup(HIPPO_PINNED_INJECT_COMMAND, 5));

  // PreCompact: fires on manual AND auto compaction (no matcher). Records the compaction, asks the
  // summariser for a "Memories for hippo" list and saves a working-state snapshot before the summary drops detail.
  // Exit-0 contract lives in the verb itself (src/capture.ts cmdPreCompact),
  // not here — this is install-time wiring only.
  const installedPreCompact = appendHookIfMissing(hooks, 'PreCompact', HIPPO_PRE_COMPACT_MARKER,
    claudeCommandGroup(`hippo pre-compact --log-file "${defaultPreCompactLogPath()}"`, 30));

  // SessionStart(compact): a SECOND SessionStart entry alongside the
  // un-matched last-sleep entry above. The matcher is an optimization, not
  // a dependency — compact-resume itself checks payload.source too, so an
  // older Claude Code that ignores the matcher just runs a silent no-op on
  // normal starts. Marker check keys on the command string, so this stays
  // idempotent alongside the sibling last-sleep entry.
  const installedCompactResume = appendHookIfMissing(hooks, 'SessionStart', HIPPO_COMPACT_RESUME_MARKER,
    claudeCommandGroup('hippo compact-resume', 10, 'compact'));

  // PostCompact: saves the memories the summariser listed and prints one line, which Claude Code only shows.
  // PreCompact stdout, by contrast, is handed to the summariser as instructions, so pre-compact prints just the request.
  const installedPostCompact = appendHookIfMissing(hooks, 'PostCompact', HIPPO_POST_COMPACT_MARKER,
    claudeCommandGroup(`hippo post-compact --log-file "${defaultPreCompactLogPath()}"`, 10));

  // PostToolUseFailure: a failed tool call becomes an error memory, after
  // `hippo capture-error` drops routine failures (interrupts, declined
  // permissions, empty searches) and repeats. Same hook the plugin ships.
  const installedCaptureError = appendHookIfMissing(hooks, 'PostToolUseFailure', HIPPO_CAPTURE_ERROR_MARKER,
    claudeCommandGroup('hippo capture-error', 10, '.*'));

  const result: InstallResult = {
    target: 'claude-code',
    settingsPath,
    installedSessionEnd,
    installedSessionStart,
    installedUserPromptSubmit,
    installedPreCompact,
    installedCompactResume,
    installedPostCompact,
    installedCaptureError,
    migratedPinnedInjectRecent,
    ...migration,
    invalidJson: false,
  };
  if (Object.values(result).some((v) => v === true)) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return result;
}

/** The exact command hippo writes for each Codex event; uninstall removes only these handlers. */
const CODEX_HOOK_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['UserPromptSubmit', HIPPO_PINNED_INJECT_COMMAND],
  ['SessionStart', HIPPO_COMPACT_RESUME_MARKER],
];

/** A group loses only hippo's handlers and goes only once empty, so a user's hook beside or like hippo's stays. */
function uninstallCodexHooks(hooks: JsonObject): boolean {
  let changed = false;
  for (const [event, command] of CODEX_HOOK_COMMANDS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let removed = false;
    const kept = groups.flatMap((group): JsonValue[] => {
      if (!isJsonObject(group) || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks.filter((h) => !(isJsonObject(h) && h.command === command));
      if (handlers.length === group.hooks.length) return [group];
      removed = true;
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (!removed) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return changed;
}

export function uninstallJsonHooks(target: JsonHookTarget): boolean {
  const { settings: settingsPath } = resolveJsonHookPaths(target);
  if (!fs.existsSync(settingsPath)) return false;

  let settings: JsonValue;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    // Never rewrite a settings file we cannot parse; report nothing uninstalled.
    return false;
  }
  if (!isJsonObject(settings) || !isJsonObject(settings.hooks)) return false;
  const changed = target === 'codex' ? uninstallCodexHooks(settings.hooks) : uninstallClaudeCodeHooks(settings.hooks);
  if (!changed) return false;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

function uninstallClaudeCodeHooks(settingsHooks: JsonObject): boolean {
  // SAFETY: each event key below is re-validated with Array.isArray before use.
  const hooks = settingsHooks as Record<string, JsonValue[]>;
  let changed = false;
  const markersByKey = {
    SessionEnd: [HIPPO_SESSION_END_MARKER, HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER],
    // Both the un-matched last-sleep entry and the matcher:'compact'
    // compact-resume entry live under the SessionStart key; the matcher
    // field doesn't affect this substring match, so removal covers both.
    SessionStart: [HIPPO_LAST_SLEEP_MARKER, HIPPO_COMPACT_RESUME_MARKER],
    UserPromptSubmit: [HIPPO_PINNED_INJECT_MARKER],
    PreCompact: [HIPPO_PRE_COMPACT_MARKER],
    PostCompact: [HIPPO_POST_COMPACT_MARKER],
    PostToolUseFailure: [HIPPO_CAPTURE_ERROR_MARKER],
    Stop: [HIPPO_SLEEP_MARKER],
  } satisfies Record<string, string[]>;
  for (const [key, markers] of Object.entries(markersByKey)) {
    if (!Array.isArray(hooks[key])) continue;
    const before = hooks[key].length;
    hooks[key] = hooks[key].filter(
      (entry) => !markers.some((m) => JSON.stringify(entry).includes(m)),
    );
    if (hooks[key].length !== before) {
      changed = true;
      if (hooks[key].length === 0) delete hooks[key];
    }
  }
  return changed;
}
