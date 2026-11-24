import {
  HIPPO_PINNED_INJECT_MARKER,
  HIPPO_PINNED_INJECT_COMMAND,
  HIPPO_COMPACT_RESUME_MARKER,
} from './shared.js';
import { type JsonValue, isJsonObjectLiteral, type JsonObject } from '../../../base/util/json.js';
import { stripHandlers } from './hook-handlers.js';
import {
  HOOK_MEDIUM_TIMEOUT_SECONDS,
  HOOK_SHORT_TIMEOUT_SECONDS,
  ensureHooksObject,
  hookAppender,
  nothingInstalled,
  type HookInstallPlan,
} from './install-plan.js';

/** A command hook with a Windows form: Codex runs hooks in PowerShell there, whose execution
 * policy can block npm's hippo.ps1. */
function codexCommandHook(command: string, timeout: number): JsonObject {
  return {
    type: 'command',
    command,
    commandWindows: command.replace(/^hippo /, 'hippo.cmd '),
    timeout,
  };
}

/** Codex keys trust to each hook's position and hash and re-asks for a changed one, so hippo
 * only appends and never edits an entry. */
export function planCodexHooks(
  settingsPath: string,
  settings: JsonValue,
  recorded: ReadonlySet<string> = new Set(),
): HookInstallPlan {
  const result = nothingInstalled('codex', settingsPath);
  const invalid = { result: { ...result, invalidJson: true }, write: null, present: [] };
  if (!isJsonObjectLiteral(settings)) return invalid;
  const hooks = ensureHooksObject(settings, ['UserPromptSubmit', 'SessionStart']);
  if (hooks === null) return invalid;
  const { append, present, leftOut } = hookAppender(hooks, recorded);
  const installedUserPromptSubmit = append('UserPromptSubmit', HIPPO_PINNED_INJECT_MARKER, {
    hooks: [codexCommandHook(HIPPO_PINNED_INJECT_COMMAND, HOOK_SHORT_TIMEOUT_SECONDS)],
  });
  const installedCompactResume = append('SessionStart', HIPPO_COMPACT_RESUME_MARKER, {
    matcher: 'compact',
    hooks: [codexCommandHook(HIPPO_COMPACT_RESUME_MARKER, HOOK_MEDIUM_TIMEOUT_SECONDS)],
  });
  return {
    result: { ...result, installedUserPromptSubmit, installedCompactResume, leftOut },
    write: installedUserPromptSubmit || installedCompactResume ? settings : null,
    present,
  };
}

const CODEX_HOOK_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['UserPromptSubmit', HIPPO_PINNED_INJECT_COMMAND],
  ['SessionStart', HIPPO_COMPACT_RESUME_MARKER],
];

/** A group loses only hippo's handlers and goes only once empty, so a user's hook beside or like
 * hippo's stays. */
export function uninstallCodexHooks(hooks: JsonObject): boolean {
  let changed = false;
  for (const [event, command] of CODEX_HOOK_COMMANDS) {
    changed = stripHandlers(hooks, event, (c) => c === command) || changed;
  }
  return changed;
}
