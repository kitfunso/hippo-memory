import {
  HIPPO_SLEEP_MARKER,
  HIPPO_LAST_SLEEP_MARKER,
  HIPPO_SESSION_RULES_MARKER,
  HIPPO_SESSION_RULES_COMMAND,
  HIPPO_CAPTURE_MARKER,
  HIPPO_SESSION_END_MARKER,
  HIPPO_PINNED_INJECT_MARKER,
  HIPPO_PINNED_INJECT_COMMAND,
  HIPPO_PRE_COMPACT_MARKER,
  HIPPO_COMPACT_RESUME_MARKER,
  HIPPO_CAPTURE_ERROR_MARKER,
  HIPPO_POST_COMPACT_MARKER,
  HIPPO_NOTE_WRITTEN_MARKER,
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
  hookAppender,
  nothingInstalled,
  type AppendHook,
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

const CLAUDE_HOOK_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['SessionEnd', [HIPPO_SESSION_END_MARKER, HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER]],
  [
    'SessionStart',
    [HIPPO_LAST_SLEEP_MARKER, HIPPO_SESSION_RULES_MARKER, HIPPO_COMPACT_RESUME_MARKER],
  ],
  ['UserPromptSubmit', [HIPPO_PINNED_INJECT_MARKER]],
  ['PreCompact', [HIPPO_PRE_COMPACT_MARKER]],
  ['PostCompact', [HIPPO_POST_COMPACT_MARKER]],
  ['PostToolUseFailure', [HIPPO_CAPTURE_ERROR_MARKER]],
  ['PostToolUse', [HIPPO_NOTE_WRITTEN_MARKER]],
  ['Stop', [HIPPO_SLEEP_MARKER]],
];

const CLAUDE_APPENDED_EVENTS = CLAUDE_HOOK_MARKERS.map(([event]) => event).filter(
  (event) => event !== 'Stop',
);

function appendSessionHooks(hooks: ClaudeHooks, append: AppendHook, logFile: string) {
  const installedSessionEnd = append(
    'SessionEnd',
    HIPPO_SESSION_END_MARKER,
    claudeCommandGroup(`hippo session-end --log-file "${logFile}"`, HOOK_SHORT_TIMEOUT_SECONDS),
  );
  const installedSessionStart = append(
    'SessionStart',
    HIPPO_LAST_SLEEP_MARKER,
    claudeCommandGroup(`hippo last-sleep --path "${logFile}"`, HOOK_SHORT_TIMEOUT_SECONDS),
  );
  // No matcher: a resumed or cleared session and a compaction lose the rules too, so every source
  // sends them again.
  const installedSessionRules = append(
    'SessionStart',
    HIPPO_SESSION_RULES_MARKER,
    claudeCommandGroup(HIPPO_SESSION_RULES_COMMAND, HOOK_SHORT_TIMEOUT_SECONDS),
  );

  const migratedPinnedInjectRecent = migratePinnedInjectRecentCommands(hooks.UserPromptSubmit);
  const installedUserPromptSubmit = append(
    'UserPromptSubmit',
    HIPPO_PINNED_INJECT_MARKER,
    claudeCommandGroup(HIPPO_PINNED_INJECT_COMMAND, HOOK_SHORT_TIMEOUT_SECONDS),
  );
  return {
    installedSessionEnd,
    installedSessionStart,
    installedSessionRules,
    migratedPinnedInjectRecent,
    installedUserPromptSubmit,
  };
}

function appendCompactionHooks(append: AppendHook, compactLog: string) {
  // PreCompact: fires on manual AND auto compaction (no matcher); records it, asks the summarizer
  // for a "Memories for hippo" list and saves a snapshot. The exit-0 contract lives in the verb
  // itself (preCompactHook, src/surface/capture/compact.ts), not in this install-time wiring.
  const installedPreCompact = append(
    'PreCompact',
    HIPPO_PRE_COMPACT_MARKER,
    claudeCommandGroup(`hippo pre-compact --log-file "${compactLog}"`, HOOK_LONG_TIMEOUT_SECONDS),
  );

  // SessionStart(compact): a second SessionStart entry beside the unmatched last-sleep one. The
  // matcher is an optimization, not a dependency: compact-resume checks payload.source itself, and
  // the marker check keys on the command string, so this stays idempotent.
  const installedCompactResume = append(
    'SessionStart',
    HIPPO_COMPACT_RESUME_MARKER,
    claudeCommandGroup('hippo compact-resume', HOOK_MEDIUM_TIMEOUT_SECONDS, 'compact'),
  );

  // PostCompact: saves the memories the summarizer listed and prints one line, which Claude Code
  // only shows. PreCompact stdout, by contrast, is handed to the summarizer as instructions, so
  // pre-compact prints just the request.
  const installedPostCompact = append(
    'PostCompact',
    HIPPO_POST_COMPACT_MARKER,
    claudeCommandGroup(
      `hippo post-compact --log-file "${compactLog}"`,
      HOOK_MEDIUM_TIMEOUT_SECONDS,
    ),
  );
  return { installedPreCompact, installedCompactResume, installedPostCompact };
}

interface ClaudeHookPaths {
  readonly settingsPath: string;
  readonly logFile: string;
  readonly compactLog: string;
  readonly noteLog: string;
}

export function planClaudeCodeHooks(
  settings: JsonObject,
  { settingsPath, logFile, compactLog, noteLog }: ClaudeHookPaths,
  recorded: ReadonlySet<string> = new Set(),
): HookInstallPlan {
  const merge = ensureHooksObject(settings, CLAUDE_APPENDED_EVENTS);
  if (merge === null) return invalidClaudeSettings(settingsPath);
  // SAFETY: ensureHooksObject left every event hippo appends to absent or an array.
  const hooks = merge as ClaudeHooks;
  const migration = migrateLegacyClaudeHooks(hooks);
  const { append, present, leftOut } = hookAppender(merge, recorded);

  const {
    installedSessionEnd,
    installedSessionStart,
    installedSessionRules,
    migratedPinnedInjectRecent,
    installedUserPromptSubmit,
  } = appendSessionHooks(hooks, append, logFile);
  const { installedPreCompact, installedCompactResume, installedPostCompact } =
    appendCompactionHooks(append, compactLog);
  const installedCaptureError = appendCaptureErrorHook(append);
  const installedNoteWritten = appendNoteWrittenHook(append, noteLog);

  const result: InstallResult = {
    target: 'claude-code',
    settingsPath,
    installedSessionEnd,
    installedSessionStart,
    installedSessionRules,
    installedUserPromptSubmit,
    installedPreCompact,
    installedCompactResume,
    installedPostCompact,
    installedCaptureError,
    installedNoteWritten,
    migratedPinnedInjectRecent,
    ...migration,
    leftOut,
    invalidJson: false,
  };
  return {
    result,
    write: Object.values(result).some((v) => v === true) ? settings : null,
    present,
  };
}

function invalidClaudeSettings(settingsPath: string): HookInstallPlan {
  return {
    result: { ...nothingInstalled('claude-code', settingsPath), invalidJson: true },
    write: null,
    present: [],
  };
}

function appendCaptureErrorHook(append: AppendHook): boolean {
  return append(
    'PostToolUseFailure',
    HIPPO_CAPTURE_ERROR_MARKER,
    claudeCommandGroup('hippo capture-error', HOOK_MEDIUM_TIMEOUT_SECONDS, '.*'),
  );
}

// Measured on Claude Code 2.1.326: an `Edit(...)` rule does not fire for a Write call, so each tool
// gets its own rule; `//**` reaches any config folder.
const NOTE_WRITTEN_IFS = [
  'Write(//**/projects/*/memory/*.md)',
  'Edit(//**/projects/*/memory/*.md)',
] as const;

function appendNoteWrittenHook(append: AppendHook, noteLog: string): boolean {
  // PostToolUse: a memory note Claude Code just wrote reaches hippo at once, in a detached worker
  // that `hippo note-written` starts. Versions that ignore `if` still get the hook's own path check.
  const command = `hippo note-written --log-file "${noteLog}"`;
  return append('PostToolUse', HIPPO_NOTE_WRITTEN_MARKER, {
    matcher: 'Edit|Write|MultiEdit',
    hooks: NOTE_WRITTEN_IFS.map((condition) => ({
      type: 'command',
      command,
      timeout: HOOK_MEDIUM_TIMEOUT_SECONDS,
      if: condition,
    })),
  });
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
