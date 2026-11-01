// Finding and stripping hippo's handlers inside a settings file's hook arrays.

import {
  type JsonValue,
  isJsonString,
  isJsonObjectLiteral,
  type JsonObject,
} from '../../../base/util/json.js';
import { escapeRegex } from '../../../base/util/escape.js';

// An unterminated quote runs to the end, as in a shell, which also keeps the scan linear.
const QUOTED_SPAN = /'[^']*(?:'|$)|"(?:[^"\\]|\\(?:[\s\S]|$))*(?:"|$)/g;

/** Hippo's command only at string start or after `(`, past env assignments and an install path,
 * with quoted text ignored: `say hippo sleep`, `echo "a; hippo sleep"` and `./backup.sh && hippo
 * sleep` stay a user's. */
export function isHippoCommand(command: string, marker: string): boolean {
  const unquoted = command.replace(QUOTED_SPAN, '');
  const pattern = `(?:^|\\()\\s*(?:[A-Za-z_]\\w*=\\S*\\s+)*(?:[^\\s(]*[/\\\\])?${escapeRegex(marker)}(?![\\w.-])`;
  return new RegExp(pattern).test(unquoted);
}

export const runsHippo =
  (...markers: string[]) =>
  (command: string): boolean =>
    markers.some((m) => isHippoCommand(command, m));

function handlerCommand(handler: JsonValue | undefined): string | null {
  return isJsonObjectLiteral(handler) && isJsonString(handler.command) ? handler.command : null;
}

/** `groups` minus the handlers `isOurs` picks; a group goes only once it has no handler left.
 * Null when no handler matched. */
export function withoutHandlers(
  groups: JsonValue[],
  isOurs: (command: string) => boolean,
): JsonValue[] | null {
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

/** Removes the matching handlers from one event's groups; the event key goes once no group
 * is left. */
export function stripHandlers(
  hooks: JsonObject,
  event: string,
  isOurs: (command: string) => boolean,
): boolean {
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;
  const kept = withoutHandlers(groups, isOurs);
  if (kept === null) return false;
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
  return true;
}

/** Every command string in `groups`; a group or handler of an unexpected shape adds none. */
export function handlerCommands(groups: JsonValue[]): string[] {
  return groups.flatMap((group) =>
    isJsonObjectLiteral(group) && Array.isArray(group.hooks)
      ? group.hooks.flatMap((h) => handlerCommand(h) ?? [])
      : [],
  );
}

/** The loose "already installed?" test, on purpose weaker than isHippoCommand: a launcher or env
 * prefix still counts, and a false hit only skips an append. */
export function hookArrayContains(hookArray: JsonValue | undefined, marker: string): boolean {
  return (
    Array.isArray(hookArray) &&
    handlerCommands(hookArray).some((command) => command.includes(marker))
  );
}
