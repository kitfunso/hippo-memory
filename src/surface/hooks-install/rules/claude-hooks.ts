// Claude Code's hooks: install, migrate older forms, and remove hippo's handlers.

import {
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
} from './shared.js';
import {
  type JsonValue,
  isJsonString,
  isJsonObjectLiteral,
  type JsonObject,
} from '../../../base/util/json.js';
import {
  handlerCommands,
  hookArrayContains,
  isHippoCommand,
  runsHippo,
  stripHandlers,
  withoutHandlers,
} from './hook-handlers.js';
import {
  HOOK_LONG_TIMEOUT_SECONDS,
  HOOK_MEDIUM_TIMEOUT_SECONDS,
  HOOK_SHORT_TIMEOUT_SECONDS,
  ensureHooksObject,
  nothingInstalled,
  type HookInstallPlan,
} from './install-plan.js';
import type { InstallResult } from './json-hooks.js';

function addIncludeRecentToPinnedCommand(command: string): string {
  if (
    !isHippoCommand(command, HIPPO_PINNED_INJECT_MARKER) ||
    command.includes('--include-recent')
  ) {
    return command;
  }
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

type ClaudeHooks = Record<string, JsonValue[]>;

interface LegacyHookMigration {
  migratedFromStop: boolean;
  migratedLegacySessionEnd: boolean;
  migratedSplitSessionEnd: boolean;
}

function migrateLegacyClaudeHooks(hooks: ClaudeHooks): LegacyHookMigration {
  const migratedFromStop = stripHandlers(hooks, 'Stop', runsHippo(HIPPO_SLEEP_MARKER));

  // The legacy SessionEnd forms in the file header collapse into `hippo session-end`, but only
  // while that entry is absent.
  let migratedLegacySessionEnd = false;
  let migratedSplitSessionEnd = false;
  if (
    Array.isArray(hooks.SessionEnd) &&
    !hookArrayContains(hooks.SessionEnd, HIPPO_SESSION_END_MARKER)
  ) {
    const kept = withoutHandlers(
      hooks.SessionEnd,
      runsHippo(HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER),
    );
    if (kept !== null) {
      // Whatever form was removed reports as the split migration; the legacy flag also marks a
      // SessionEnd that held several groups.
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

function appendHookIfMissing(
  hooks: ClaudeHooks,
  event: string,
  marker: string,
  group: JsonObject,
): boolean {
  if (hookArrayContains(hooks[event], marker)) return false;
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  hooks[event].push(group);
  return true;
}

/** Every command hippo has written to Claude Code's settings per event, the legacy forms
 * included; uninstall removes only handlers that run one. */
const CLAUDE_HOOK_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['SessionEnd', [HIPPO_SESSION_END_MARKER, HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER]],
  ['SessionStart', [HIPPO_LAST_SLEEP_MARKER, HIPPO_COMPACT_RESUME_MARKER]],
  ['UserPromptSubmit', [HIPPO_PINNED_INJECT_MARKER]],
  ['PreCompact', [HIPPO_PRE_COMPACT_MARKER]],
  ['PostCompact', [HIPPO_POST_COMPACT_MARKER]],
  ['PostToolUseFailure', [HIPPO_CAPTURE_ERROR_MARKER]],
  ['Stop', [HIPPO_SLEEP_MARKER]],
];

// Stop is only ever migrated away, so install never appends to it and a Stop that is not a list
// does not block the install.
const CLAUDE_APPENDED_EVENTS = CLAUDE_HOOK_MARKERS.map(([event]) => event).filter(
  (event) => event !== 'Stop',
);

function appendSessionHooks(hooks: ClaudeHooks, logFile: string) {
  const installedSessionEnd = appendHookIfMissing(
    hooks,
    'SessionEnd',
    HIPPO_SESSION_END_MARKER,
    claudeCommandGroup(`hippo session-end --log-file "${logFile}"`, HOOK_SHORT_TIMEOUT_SECONDS),
  );
  const installedSessionStart = appendHookIfMissing(
    hooks,
    'SessionStart',
    HIPPO_LAST_SLEEP_MARKER,
    claudeCommandGroup(`hippo last-sleep --path "${logFile}"`, HOOK_SHORT_TIMEOUT_SECONDS),
  );

  // Mid-session pinned-rule re-injection: UserPromptSubmit runs every turn, so pinned memories stay
  // in context; the fresh write tail makes lessons saved earlier in the session visible on the next
  // prompt even before they are pinned.
  const migratedPinnedInjectRecent = migratePinnedInjectRecentCommands(hooks.UserPromptSubmit);
  const installedUserPromptSubmit = appendHookIfMissing(
    hooks,
    'UserPromptSubmit',
    HIPPO_PINNED_INJECT_MARKER,
    claudeCommandGroup(HIPPO_PINNED_INJECT_COMMAND, HOOK_SHORT_TIMEOUT_SECONDS),
  );
  return {
    installedSessionEnd,
    installedSessionStart,
    migratedPinnedInjectRecent,
    installedUserPromptSubmit,
  };
}

function appendCompactionHooks(hooks: ClaudeHooks, compactLog: string) {
  // PreCompact: fires on manual AND auto compaction (no matcher); records it, asks the summarizer
  // for a "Memories for hippo" list and saves a snapshot. The exit-0 contract lives in the verb
  // itself (preCompactHook, src/surface/capture/compact.ts), not in this install-time wiring.
  const installedPreCompact = appendHookIfMissing(
    hooks,
    'PreCompact',
    HIPPO_PRE_COMPACT_MARKER,
    claudeCommandGroup(`hippo pre-compact --log-file "${compactLog}"`, HOOK_LONG_TIMEOUT_SECONDS),
  );

  // SessionStart(compact): a second SessionStart entry beside the unmatched last-sleep one. The
  // matcher is an optimization, not a dependency: compact-resume checks payload.source itself, and
  // the marker check keys on the command string, so this stays idempotent.
  const installedCompactResume = appendHookIfMissing(
    hooks,
    'SessionStart',
    HIPPO_COMPACT_RESUME_MARKER,
    claudeCommandGroup('hippo compact-resume', HOOK_MEDIUM_TIMEOUT_SECONDS, 'compact'),
  );

  // PostCompact: saves the memories the summarizer listed and prints one line, which Claude Code
  // only shows. PreCompact stdout, by contrast, is handed to the summarizer as instructions, so
  // pre-compact prints just the request.
  const installedPostCompact = appendHookIfMissing(
    hooks,
    'PostCompact',
    HIPPO_POST_COMPACT_MARKER,
    claudeCommandGroup(
      `hippo post-compact --log-file "${compactLog}"`,
      HOOK_MEDIUM_TIMEOUT_SECONDS,
    ),
  );
  return { installedPreCompact, installedCompactResume, installedPostCompact };
}

/** Where Claude Code's settings live and where its session and compaction hooks log. */
interface ClaudeHookPaths {
  readonly settingsPath: string;
  readonly logFile: string;
  readonly compactLog: string;
}

export function planClaudeCodeHooks(
  settings: JsonObject,
  { settingsPath, logFile, compactLog }: ClaudeHookPaths,
): HookInstallPlan {
  const merge = ensureHooksObject(settings, CLAUDE_APPENDED_EVENTS);
  if (merge === null) return invalidClaudeSettings(settingsPath);
  // SAFETY: ensureHooksObject left every event hippo appends to absent or an array.
  const hooks = merge as ClaudeHooks;
  const migration = migrateLegacyClaudeHooks(hooks);

  const {
    installedSessionEnd,
    installedSessionStart,
    migratedPinnedInjectRecent,
    installedUserPromptSubmit,
  } = appendSessionHooks(hooks, logFile);
  const { installedPreCompact, installedCompactResume, installedPostCompact } =
    appendCompactionHooks(hooks, compactLog);
  const installedCaptureError = appendCaptureErrorHook(hooks);

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

function invalidClaudeSettings(settingsPath: string): HookInstallPlan {
  return {
    result: { ...nothingInstalled('claude-code', settingsPath), invalidJson: true },
    write: null,
  };
}

function appendCaptureErrorHook(hooks: ClaudeHooks): boolean {
  // PostToolUseFailure: a failed tool call becomes an error memory, after `hippo capture-error`
  // drops routine failures (interrupts, declined permissions, empty searches) and repeats. Same
  // hook the plugin ships.
  return appendHookIfMissing(
    hooks,
    'PostToolUseFailure',
    HIPPO_CAPTURE_ERROR_MARKER,
    claudeCommandGroup('hippo capture-error', HOOK_MEDIUM_TIMEOUT_SECONDS, '.*'),
  );
}

/** The Claude Code handlers uninstall kept that still mention a hippo command (`nice hippo
 * sleep`, `pnpm exec hippo ...`), so the user can be told to remove them by hand. */
export function keptHippoHandlers(hooks: JsonObject): string[] {
  return CLAUDE_HOOK_MARKERS.flatMap(([event, markers]) => {
    const groups = hooks[event];
    return Array.isArray(groups)
      ? handlerCommands(groups).filter((command) => markers.some((m) => command.includes(m)))
      : [];
  });
}

export function uninstallClaudeCodeHooks(hooks: JsonObject): boolean {
  let changed = false;
  for (const [event, markers] of CLAUDE_HOOK_MARKERS) {
    changed = stripHandlers(hooks, event, runsHippo(...markers)) || changed;
  }
  return changed;
}
