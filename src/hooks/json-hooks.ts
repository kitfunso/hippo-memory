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
import { isJsonObject, type JsonHookTarget, HIPPO_SLEEP_MARKER, HIPPO_LAST_SLEEP_MARKER, HIPPO_CAPTURE_MARKER, HIPPO_SESSION_END_MARKER, HIPPO_PINNED_INJECT_MARKER, HIPPO_PINNED_INJECT_COMMAND, HIPPO_PRE_COMPACT_MARKER, HIPPO_COMPACT_RESUME_MARKER, HIPPO_CAPTURE_ERROR_MARKER, HIPPO_POST_COMPACT_MARKER, homeDir, claudeConfigDir, codexHomeDir, defaultPreCompactLogPath } from './shared.js';
import { type JsonValue, isJsonString } from '../json.js';
import { escapeRegex } from '../escape.js';

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
        settings: path.join(claudeConfigDir(home), 'settings.json'),
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

/** Hippo's command only where a command begins (line start or after `;` `&` `|` `(`, an install path allowed), so `say hippo sleep` or `echo "hippo sleep"` stays a user's. */
function isHippoCommand(command: string, marker: string): boolean {
  return new RegExp(`(?:^|[;&|(])\\s*(?:\\S*[/\\\\])?${escapeRegex(marker)}(?![\\w.-])`).test(command);
}

const runsHippo = (...markers: string[]) => (command: string): boolean => markers.some((m) => isHippoCommand(command, m));

function handlerCommand(handler: JsonValue | undefined): string | null {
  return isJsonObject(handler) && isJsonString(handler.command) ? handler.command : null;
}

/** `groups` minus the handlers `isOurs` picks; a group goes only once it has no handler left. Null when no handler matched. */
function withoutHandlers(groups: JsonValue[], isOurs: (command: string) => boolean): JsonValue[] | null {
  let removed = false;
  const kept = groups.flatMap((group): JsonValue[] => {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) return [group];
    const handlers = group.hooks.filter((h) => {
      const command = handlerCommand(h);
      return command === null || !isOurs(command);
    });
    if (handlers.length === group.hooks.length) return [group];
    removed = true;
    return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
  });
  return removed ? kept : null;
}

/** Removes the matching handlers from one event's groups; the event key goes once no group is left. */
function stripHandlers(hooks: JsonObject, event: string, isOurs: (command: string) => boolean): boolean {
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;
  const kept = withoutHandlers(groups, isOurs);
  if (kept === null) return false;
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
  return true;
}

function hookArrayContains(hookArray: JsonValue | undefined, marker: string): boolean {
  return Array.isArray(hookArray) && withoutHandlers(hookArray, runsHippo(marker)) !== null;
}

function addIncludeRecentToPinnedCommand(command: string): string {
  if (!isHippoCommand(command, HIPPO_PINNED_INJECT_MARKER) || command.includes('--include-recent')) return command;
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

/** `settings.hooks` once it is an object whose `events`, where present, are arrays; null when appending would overwrite anything else. */
function mergeableHooks(settings: JsonObject, events: readonly string[]): JsonObject | null {
  if (settings.hooks === undefined) settings.hooks = {};
  const hooks = settings.hooks;
  if (!isJsonObject(hooks) || events.some((e) => hooks[e] !== undefined && !Array.isArray(hooks[e]))) return null;
  return hooks;
}

/** Codex keys trust to each hook's position and hash and re-asks for a changed one, so hippo only appends and never edits an entry. */
function installCodexHooks(settingsPath: string, settings: JsonValue): InstallResult {
  const result = nothingInstalled('codex', settingsPath);
  if (!isJsonObject(settings)) return { ...result, invalidJson: true };
  const hooks = mergeableHooks(settings, ['UserPromptSubmit', 'SessionStart']);
  if (hooks === null) return { ...result, invalidJson: true };
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
  if (installedUserPromptSubmit || installedCompactResume) writeSettingsFile(settingsPath, settings);
  return { ...result, installedUserPromptSubmit, installedCompactResume };
}

export function installJsonHooks(target: JsonHookTarget): InstallResult {
  const { settings: settingsPath, logFile } = resolveJsonHookPaths(target);
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let settings: JsonValue = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = readSettingsFile(settingsPath);
    } catch {
      return { ...nothingInstalled(target, settingsPath), invalidJson: true };
    }
  }
  if (target === 'codex') return installCodexHooks(settingsPath, settings);
  if (!isJsonObject(settings)) return { ...nothingInstalled(target, settingsPath), invalidJson: true };
  return installClaudeCodeHooks(settingsPath, settings, logFile);
}

/** Windows PowerShell 5.1 saves JSON with a UTF-8 byte order mark that JSON.parse rejects, so one leading mark is dropped. */
export function readSettingsFile(file: string): JsonValue {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.codePointAt(0) === 0xfeff ? text.slice(1) : text);
}

const RENAME_RETRY_MS = 1000;

/** Windows refuses a rename onto a file another program has open, usually for a moment, so a refusal is retried before it is reported. */
function renameOnto(tmp: string, target: string): void {
  const deadline = Date.now() + RENAME_RETRY_MS;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  for (let pause = 10; ; pause = Math.min(pause * 2, 200)) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      const refused = err instanceof Error && 'code' in err && ['EPERM', 'EACCES', 'EBUSY'].includes(String(err.code));
      if (process.platform !== 'win32' || !refused) throw err;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${target} is in use by another program, so hippo could not replace it; close that program and run the command again`, { cause: err });
      Atomics.wait(idle, 0, 0, Math.min(pause, left));
    }
  }
}

/** Swaps the file in with one rename, so a crash mid-write cannot leave a truncated settings.json that Claude Code cannot parse. */
function writeSettingsFile(file: string, settings: JsonValue): void {
  // Resolved through a symlink so a dotfile manager's link survives, and written with the old mode so a private file stays private.
  const exists = fs.existsSync(file);
  const target = exists ? fs.realpathSync(file) : file;
  // A rename replaces a read-only file that the in-place write refused, and Windows would retry that refusal for a second.
  if (exists) fs.accessSync(target, fs.constants.W_OK);
  const mode = (fs.statSync(target, { throwIfNoEntry: false })?.mode ?? 0o666) & 0o777;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode });
    renameOnto(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

type ClaudeHooks = Record<string, JsonValue[]>;

interface LegacyHookMigration {
  migratedFromStop: boolean;
  migratedLegacySessionEnd: boolean;
  migratedSplitSessionEnd: boolean;
}

function migrateLegacyClaudeHooks(hooks: ClaudeHooks): LegacyHookMigration {
  let migratedFromStop = false;
  if (Array.isArray(hooks.Stop)) {
    const kept = withoutHandlers(hooks.Stop, runsHippo(HIPPO_SLEEP_MARKER));
    if (kept !== null) {
      if (kept.length === 0) delete hooks.Stop;
      else hooks.Stop = kept;
      migratedFromStop = true;
    }
  }

  // The legacy SessionEnd forms in the file header collapse into `hippo session-end`, but only while that entry is absent.
  let migratedLegacySessionEnd = false;
  let migratedSplitSessionEnd = false;
  if (Array.isArray(hooks.SessionEnd) && !hookArrayContains(hooks.SessionEnd, HIPPO_SESSION_END_MARKER)) {
    const kept = withoutHandlers(hooks.SessionEnd, runsHippo(HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER));
    if (kept !== null) {
      // If the removed entries used the log-file pattern (0.21.x-0.22.x) we
      // call it a "split" migration; otherwise it was the older bare form.
      migratedSplitSessionEnd = true;
      migratedLegacySessionEnd = hooks.SessionEnd.length > 1;
      if (kept.length === 0) delete hooks.SessionEnd;
      else hooks.SessionEnd = kept;
    }
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

const CLAUDE_APPENDED_EVENTS = ['SessionEnd', 'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact', 'PostToolUseFailure'] as const;

function installClaudeCodeHooks(settingsPath: string, settings: JsonObject, logFile: string): InstallResult {
  const merge = mergeableHooks(settings, CLAUDE_APPENDED_EVENTS);
  if (merge === null) return { ...nothingInstalled('claude-code', settingsPath), invalidJson: true };
  // SAFETY: mergeableHooks left every event hippo appends to absent or an array.
  const hooks = merge as ClaudeHooks;
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
  if (Object.values(result).some((v) => v === true)) writeSettingsFile(settingsPath, settings);
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
  for (const [event, command] of CODEX_HOOK_COMMANDS) changed = stripHandlers(hooks, event, (c) => c === command) || changed;
  return changed;
}

export function uninstallJsonHooks(target: JsonHookTarget): boolean {
  const { settings: settingsPath } = resolveJsonHookPaths(target);
  if (!fs.existsSync(settingsPath)) return false;

  let settings: JsonValue;
  try {
    settings = readSettingsFile(settingsPath);
  } catch {
    // Never rewrite a settings file we cannot parse; report nothing uninstalled.
    return false;
  }
  if (!isJsonObject(settings) || !isJsonObject(settings.hooks)) return false;
  const changed = target === 'codex' ? uninstallCodexHooks(settings.hooks) : uninstallClaudeCodeHooks(settings.hooks);
  if (!changed) return false;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettingsFile(settingsPath, settings);
  return true;
}

/** Every command hippo has written to Claude Code's settings per event, the legacy forms included; uninstall removes only handlers that run one. */
const CLAUDE_HOOK_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['SessionEnd', [HIPPO_SESSION_END_MARKER, HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER]],
  ['SessionStart', [HIPPO_LAST_SLEEP_MARKER, HIPPO_COMPACT_RESUME_MARKER]],
  ['UserPromptSubmit', [HIPPO_PINNED_INJECT_MARKER]],
  ['PreCompact', [HIPPO_PRE_COMPACT_MARKER]],
  ['PostCompact', [HIPPO_POST_COMPACT_MARKER]],
  ['PostToolUseFailure', [HIPPO_CAPTURE_ERROR_MARKER]],
  ['Stop', [HIPPO_SLEEP_MARKER]],
];

function uninstallClaudeCodeHooks(hooks: JsonObject): boolean {
  let changed = false;
  for (const [event, markers] of CLAUDE_HOOK_MARKERS) changed = stripHandlers(hooks, event, runsHippo(...markers)) || changed;
  return changed;
}
