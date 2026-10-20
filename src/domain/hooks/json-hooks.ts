/** Hook install and removal rules for AI coding tools, on parsed settings: Claude Code gets a JSON `hooks` block in
 * settings.json with older forms migrated, Codex an appended one, Copilot a whole file; surface/hooks-install does the
 * reads and writes. */

import * as path from 'path';
import {
  type JsonHookTarget,
  HIPPO_SLEEP_MARKER,
  HIPPO_LAST_SLEEP_MARKER,
  HIPPO_CAPTURE_MARKER,
  HIPPO_SESSION_END_MARKER,
  HIPPO_PINNED_INJECT_MARKER,
  HIPPO_PINNED_INJECT_COMMAND,
  HIPPO_PRE_COMPACT_MARKER,
  HIPPO_COMPACT_RESUME_MARKER,
  HIPPO_CAPTURE_ERROR_MARKER,
  HIPPO_POST_COMPACT_MARKER,
  copilotHooksFile,
  defaultPreCompactLogPath,
} from './shared.js';
import { claudeConfigDir, codexHomeDir, homeDir } from '../../base/util/agent-homes.js';
import { type JsonValue, isJsonString, isJsonObjectLiteral, type JsonObject } from '../../base/util/json.js';
import { escapeRegex } from '../../base/util/escape.js';

/** A target's hook settings file, the log its SessionEnd hook writes, and the tool's display name. */
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

/** The paths for `target` under the current home directory; reads and writes nothing. */
export function resolveJsonHookPaths(target: JsonHookTarget): JsonHookPaths {
  const home = homeDir();
  const logsDir = path.join(home, '.hippo', 'logs');
  switch (target) {
    case 'claude-code':
      return {
        settings: path.join(claudeConfigDir(), 'settings.json'),
        logFile: path.join(logsDir, 'claude-code-sleep.log'),
        display: 'Claude Code',
      };
    case 'codex':
      return {
        settings: path.join(codexHomeDir(home), 'hooks.json'),
        logFile: path.join(logsDir, 'codex-sleep.log'),
        display: 'Codex',
      };
    case 'copilot':
      return {
        settings: copilotHooksFile(),
        logFile: path.join(logsDir, 'copilot-sleep.log'),
        display: 'Copilot',
      };
  }
}

// An unterminated quote runs to the end, as in a shell, which also keeps the scan linear.
const QUOTED_SPAN = /'[^']*(?:'|$)|"(?:[^"\\]|\\(?:[\s\S]|$))*(?:"|$)/g;

/** Hippo's command only at string start or after `(`, past env assignments and an install path, with quoted text
 * ignored: `say hippo sleep`, `echo "a; hippo sleep"` and `./backup.sh && hippo sleep` stay a user's. */
function isHippoCommand(command: string, marker: string): boolean {
  const unquoted = command.replace(QUOTED_SPAN, '');
  const pattern = `(?:^|\\()\\s*(?:[A-Za-z_]\\w*=\\S*\\s+)*(?:[^\\s(]*[/\\\\])?${escapeRegex(marker)}(?![\\w.-])`;
  return new RegExp(pattern).test(unquoted);
}

const runsHippo =
  (...markers: string[]) =>
  (command: string): boolean =>
    markers.some((m) => isHippoCommand(command, m));

function handlerCommand(handler: JsonValue | undefined): string | null {
  return isJsonObjectLiteral(handler) && isJsonString(handler.command) ? handler.command : null;
}

/** `groups` minus the handlers `isOurs` picks; a group goes only once it has no handler left. Null when no handler
 * matched. */
function withoutHandlers(groups: JsonValue[], isOurs: (command: string) => boolean): JsonValue[] | null {
  let removed = false;
  const kept = groups.flatMap((group): JsonValue[] => {
    if (!isJsonObjectLiteral(group) || !Array.isArray(group.hooks)) return [group];
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

/** Every command string in `groups`; a group or handler of an unexpected shape adds none. */
function handlerCommands(groups: JsonValue[]): string[] {
  return groups.flatMap((group) =>
    isJsonObjectLiteral(group) && Array.isArray(group.hooks) ? group.hooks.flatMap((h) => handlerCommand(h) ?? []) : [],
  );
}

/** The loose "already installed?" test, on purpose weaker than isHippoCommand: a launcher or env prefix still counts,
 * and a false hit only skips an append. */
function hookArrayContains(hookArray: JsonValue | undefined, marker: string): boolean {
  return Array.isArray(hookArray) && handlerCommands(hookArray).some((command) => command.includes(marker));
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
    if (!isJsonObjectLiteral(entry)) continue;
    const innerHooks = entry.hooks;
    if (!Array.isArray(innerHooks)) continue;
    for (const hook of innerHooks) {
      if (!isJsonObjectLiteral(hook)) continue;
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

/** A command hook with a Windows form: Codex runs hooks in PowerShell there, whose execution policy can block npm's
 * hippo.ps1. */
function codexCommandHook(command: string, timeout: number): JsonObject {
  return { type: 'command', command, commandWindows: command.replace(/^hippo /, 'hippo.cmd '), timeout };
}

/** Assigns `settings.hooks = {}` when it is absent, then returns it if it is an object whose `events`, where present,
 * are arrays; null when appending would overwrite anything else. */
function ensureHooksObject(settings: JsonObject, events: readonly string[]): JsonObject | null {
  if (settings.hooks === undefined) settings.hooks = {};
  const hooks = settings.hooks;
  if (!isJsonObjectLiteral(hooks)) return null;
  if (events.some((e) => hooks[e] !== undefined && !Array.isArray(hooks[e]))) return null;
  return hooks;
}

/** What an install does to one settings file: the result to report, and the settings to write, null when the file
 * stays as it is. */
export interface HookInstallPlan {
  readonly result: InstallResult;
  readonly write: JsonValue | null;
}

/** Codex keys trust to each hook's position and hash and re-asks for a changed one, so hippo only appends and never
 * edits an entry. */
function planCodexHooks(settingsPath: string, settings: JsonValue): HookInstallPlan {
  const result = nothingInstalled('codex', settingsPath);
  if (!isJsonObjectLiteral(settings)) return { result: { ...result, invalidJson: true }, write: null };
  const hooks = ensureHooksObject(settings, ['UserPromptSubmit', 'SessionStart']);
  if (hooks === null) return { result: { ...result, invalidJson: true }, write: null };
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
  return {
    result: { ...result, installedUserPromptSubmit, installedCompactResume },
    write: installedUserPromptSubmit || installedCompactResume ? settings : null,
  };
}

/** One Copilot entry with a PowerShell twin: VS Code runs only `powershell` on Windows, where the execution policy can
 * block npm's hippo.ps1. */
function copilotCommandHook(args: string, timeoutSec: number): JsonValue[] {
  return [{ type: 'command', bash: `hippo ${args}`, powershell: `hippo.cmd ${args}`, timeoutSec }];
}

/** No command names a path, so nothing has to be quoted for bash and PowerShell; session-end --runtime copilot picks
 * its own log file. */
function copilotHooksTable(): JsonObject {
  return {
    version: 1,
    hooks: {
      sessionStart: copilotCommandHook('context --pinned-only --include-recent 5 --format copilot', 10),
      postToolUseFailure: copilotCommandHook('capture-error --runtime copilot', 10),
      preCompact: copilotCommandHook('pre-compact --runtime copilot', 30),
      // VS Code maps no camelCase preCompact. The Copilot CLI may run both names, so pre-compact skips a snapshot saved
      // seconds before.
      PreCompact: copilotCommandHook('pre-compact --runtime copilot', 30),
      // VS Code's per-reply Stop. --turn acts on a VS Code payload only, so the Copilot CLI's agentStop does nothing.
      agentStop: copilotCommandHook('session-end --runtime copilot --turn', 30),
      sessionEnd: copilotCommandHook('session-end --runtime copilot', 30),
    },
  };
}

/** The events in hippo's Copilot hooks file, in file order, for setup to name. */
export function copilotHookEvents(): string[] {
  const hooks = copilotHooksTable().hooks;
  return isJsonObjectLiteral(hooks) ? Object.keys(hooks) : [];
}

/** A settings file's text as hippo writes it, so an install can tell an unchanged file from one it must write. */
export function settingsText(settings: JsonValue): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Hippo owns this whole file, so install writes the full table and a second install changes no byte. */
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

/** Adds hippo's hooks to parsed settings, which it edits in place, and migrates older hippo entries; `settings` is
 * undefined for a file that is not JSON, which stays untouched. */
export function planJsonHooks(
  target: 'claude-code' | 'codex',
  paths: Pick<JsonHookPaths, 'settings' | 'logFile'>,
  settings: JsonValue | undefined,
): HookInstallPlan {
  const invalid = { result: { ...nothingInstalled(target, paths.settings), invalidJson: true }, write: null };
  if (settings === undefined) return invalid;
  if (target === 'codex') return planCodexHooks(paths.settings, settings);
  if (!isJsonObjectLiteral(settings)) return invalid;
  return planClaudeCodeHooks(paths.settings, settings, paths.logFile);
}

type ClaudeHooks = Record<string, JsonValue[]>;

interface LegacyHookMigration {
  migratedFromStop: boolean;
  migratedLegacySessionEnd: boolean;
  migratedSplitSessionEnd: boolean;
}

function migrateLegacyClaudeHooks(hooks: ClaudeHooks): LegacyHookMigration {
  const migratedFromStop = stripHandlers(hooks, 'Stop', runsHippo(HIPPO_SLEEP_MARKER));

  // The legacy SessionEnd forms in the file header collapse into `hippo session-end`, but only while that entry is
  // absent.
  let migratedLegacySessionEnd = false;
  let migratedSplitSessionEnd = false;
  if (Array.isArray(hooks.SessionEnd) && !hookArrayContains(hooks.SessionEnd, HIPPO_SESSION_END_MARKER)) {
    const kept = withoutHandlers(hooks.SessionEnd, runsHippo(HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER));
    if (kept !== null) {
      // Whatever form was removed reports as the split migration; the legacy flag also marks a SessionEnd that held
      // several groups.
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

/** Every command hippo has written to Claude Code's settings per event, the legacy forms included; uninstall removes
 * only handlers that run one. */
const CLAUDE_HOOK_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['SessionEnd', [HIPPO_SESSION_END_MARKER, HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER]],
  ['SessionStart', [HIPPO_LAST_SLEEP_MARKER, HIPPO_COMPACT_RESUME_MARKER]],
  ['UserPromptSubmit', [HIPPO_PINNED_INJECT_MARKER]],
  ['PreCompact', [HIPPO_PRE_COMPACT_MARKER]],
  ['PostCompact', [HIPPO_POST_COMPACT_MARKER]],
  ['PostToolUseFailure', [HIPPO_CAPTURE_ERROR_MARKER]],
  ['Stop', [HIPPO_SLEEP_MARKER]],
];

// Stop is only ever migrated away, so install never appends to it and a Stop that is not a list does not block the
// install.
const CLAUDE_APPENDED_EVENTS = CLAUDE_HOOK_MARKERS.map(([event]) => event).filter((event) => event !== 'Stop');

function appendSessionHooks(hooks: ClaudeHooks, logFile: string) {
  const installedSessionEnd = appendHookIfMissing(
    hooks,
    'SessionEnd',
    HIPPO_SESSION_END_MARKER,
    claudeCommandGroup(`hippo session-end --log-file "${logFile}"`, 5),
  );
  const installedSessionStart = appendHookIfMissing(
    hooks,
    'SessionStart',
    HIPPO_LAST_SLEEP_MARKER,
    claudeCommandGroup(`hippo last-sleep --path "${logFile}"`, 5),
  );

  // Mid-session pinned-rule re-injection: UserPromptSubmit runs every turn, so pinned memories stay in context; the
  // fresh write tail makes lessons saved earlier in the session visible on the next prompt even before they are pinned.
  const migratedPinnedInjectRecent = migratePinnedInjectRecentCommands(hooks.UserPromptSubmit);
  const installedUserPromptSubmit = appendHookIfMissing(
    hooks,
    'UserPromptSubmit',
    HIPPO_PINNED_INJECT_MARKER,
    claudeCommandGroup(HIPPO_PINNED_INJECT_COMMAND, 5),
  );
  return { installedSessionEnd, installedSessionStart, migratedPinnedInjectRecent, installedUserPromptSubmit };
}

function appendCompactionHooks(hooks: ClaudeHooks) {
  // PreCompact: fires on manual AND auto compaction (no matcher); records it, asks the summarizer for a "Memories for
  // hippo" list and saves a snapshot. The exit-0 contract lives in the verb itself (cmdPreCompact,
  // src/surface/capture/compact.ts), not in this install-time wiring.
  const installedPreCompact = appendHookIfMissing(
    hooks,
    'PreCompact',
    HIPPO_PRE_COMPACT_MARKER,
    claudeCommandGroup(`hippo pre-compact --log-file "${defaultPreCompactLogPath()}"`, 30),
  );

  // SessionStart(compact): a second SessionStart entry beside the unmatched last-sleep one. The matcher is an
  // optimization, not a dependency: compact-resume checks payload.source itself, and the marker check keys on the
  // command string, so this stays idempotent.
  const installedCompactResume = appendHookIfMissing(
    hooks,
    'SessionStart',
    HIPPO_COMPACT_RESUME_MARKER,
    claudeCommandGroup('hippo compact-resume', 10, 'compact'),
  );

  // PostCompact: saves the memories the summarizer listed and prints one line, which Claude Code only shows. PreCompact
  // stdout, by contrast, is handed to the summarizer as instructions, so pre-compact prints just the request.
  const installedPostCompact = appendHookIfMissing(
    hooks,
    'PostCompact',
    HIPPO_POST_COMPACT_MARKER,
    claudeCommandGroup(`hippo post-compact --log-file "${defaultPreCompactLogPath()}"`, 10),
  );
  return { installedPreCompact, installedCompactResume, installedPostCompact };
}

function planClaudeCodeHooks(settingsPath: string, settings: JsonObject, logFile: string): HookInstallPlan {
  const merge = ensureHooksObject(settings, CLAUDE_APPENDED_EVENTS);
  if (merge === null) {
    return { result: { ...nothingInstalled('claude-code', settingsPath), invalidJson: true }, write: null };
  }
  // SAFETY: ensureHooksObject left every event hippo appends to absent or an array.
  const hooks = merge as ClaudeHooks;
  const migration = migrateLegacyClaudeHooks(hooks);

  const { installedSessionEnd, installedSessionStart, migratedPinnedInjectRecent, installedUserPromptSubmit } =
    appendSessionHooks(hooks, logFile);
  const { installedPreCompact, installedCompactResume, installedPostCompact } = appendCompactionHooks(hooks);

  // PostToolUseFailure: a failed tool call becomes an error memory, after `hippo capture-error` drops routine failures
  // (interrupts, declined permissions, empty searches) and repeats. Same hook the plugin ships.
  const installedCaptureError = appendHookIfMissing(
    hooks,
    'PostToolUseFailure',
    HIPPO_CAPTURE_ERROR_MARKER,
    claudeCommandGroup('hippo capture-error', 10, '.*'),
  );

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
  return { result, write: Object.values(result).some((v) => v === true) ? settings : null };
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
    changed = stripHandlers(hooks, event, (c) => c === command) || changed;
  }
  return changed;
}

/** The Claude Code handlers uninstall kept that still mention a hippo command (`nice hippo sleep`, `pnpm exec hippo
 * ...`), so the user can be told to remove them by hand. */
function keptHippoHandlers(hooks: JsonObject): string[] {
  return CLAUDE_HOOK_MARKERS.flatMap(([event, markers]) => {
    const groups = hooks[event];
    return Array.isArray(groups)
      ? handlerCommands(groups).filter((command) => markers.some((m) => command.includes(m)))
      : [];
  });
}

/** What uninstall does to parsed settings, edited in place: the settings to write (null when nothing changed) and, for
 * Claude Code, the kept handlers that still name a hippo command. */
export interface HookRemovalPlan {
  readonly write: JsonObject | null;
  readonly kept: readonly string[];
}

/** Removes hippo's own hook handlers and keeps every other handler. */
export function planHookRemoval(target: 'claude-code' | 'codex', settings: JsonValue): HookRemovalPlan {
  if (!isJsonObjectLiteral(settings) || !isJsonObjectLiteral(settings.hooks)) return { write: null, kept: [] };
  const hooks = settings.hooks;
  const changed = target === 'codex' ? uninstallCodexHooks(hooks) : uninstallClaudeCodeHooks(hooks);
  const kept = target === 'claude-code' ? keptHippoHandlers(hooks) : [];
  if (!changed) return { write: null, kept };
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return { write: settings, kept };
}

/** False for settings uninstall cannot edit: not a JSON object (undefined when the text did not parse), or a `hooks`
 * that is not one. */
export function canEditHooks(settings: JsonValue | undefined): boolean {
  return isJsonObjectLiteral(settings) && (settings.hooks === undefined || isJsonObjectLiteral(settings.hooks));
}

function uninstallClaudeCodeHooks(hooks: JsonObject): boolean {
  let changed = false;
  for (const [event, markers] of CLAUDE_HOOK_MARKERS) {
    changed = stripHandlers(hooks, event, runsHippo(...markers)) || changed;
  }
  return changed;
}
