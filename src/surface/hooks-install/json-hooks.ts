// Reads and writes each tool's hook settings file; what changes in it is domain/hooks/json-hooks.ts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { type JsonValue } from '../../base/util/json.js';
import { readJsonFile, tryReadJsonFile } from '../../host/json-file.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { processHomes } from '../../host/agent-homes.js';
import {
  canEditHooks,
  jsonHookPathsOn,
  planCopilotHooks,
  planHookRemoval,
  planJsonHooks,
  settingsText,
  type InstallResult,
  type JsonHookPaths,
} from '../../domain/hooks/json-hooks.js';
import {
  defaultPreCompactLogPath,
  defaultSleepLogPath as sleepLogOn,
  type JsonHookTarget,
} from '../../domain/hooks/shared.js';

// What a caller of the installer names beside it: the Copilot events it adds and the reminder Codex needs before it
// runs a new hook.
export { copilotHookEvents } from '../../domain/hooks/json-hooks.js';
export { CODEX_TRUST_LINE } from '../../domain/hooks/shared.js';

/** The paths for `target` under this process's home folder; reads and writes nothing. */
export function resolveJsonHookPaths(target: JsonHookTarget): JsonHookPaths {
  return jsonHookPathsOn(target, processHomes());
}

/** The log the SessionStart hook reads when a caller passes no --path. */
export function defaultSleepLogPath(): string {
  return sleepLogOn(processHomes());
}

/** Swaps the file in with one rename, so a crash mid-write cannot leave a truncated settings.json that Claude Code
 * cannot parse. */
export function writeSettingsFile(file: string, settings: JsonValue): void {
  writeFileAtomic(file, settingsText(settings));
}

/** Parsed settings, `{}` for a missing file, or undefined for one that is not JSON. */
function readSettings(file: string): JsonValue | undefined {
  return fs.existsSync(file) ? tryReadJsonFile(file) : {};
}

/** Adds hippo's hooks to `target`'s settings file and migrates older hippo entries; a file that is not JSON stays
 * untouched. */
export function installJsonHooks(target: JsonHookTarget): InstallResult {
  const paths = resolveJsonHookPaths(target);
  const dir = path.dirname(paths.settings);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const plan =
    target === 'copilot'
      ? planCopilotHooks(paths.settings, fs.existsSync(paths.settings) ? fs.readFileSync(paths.settings, 'utf8') : null)
      : planJsonHooks(target, paths, readSettings(paths.settings), defaultPreCompactLogPath(processHomes()));
  if (plan.write !== null) writeSettingsFile(paths.settings, plan.write);
  return plan.result;
}

/** Never rewrites a settings file that does not parse; a read failure (a permission, a folder) throws to the caller. */
function readForRemoval(settingsPath: string): JsonValue | undefined {
  try {
    return readJsonFile(settingsPath);
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw new Error(`could not read ${settingsPath}: ${errorMessage(err)}`, { cause: err });
    }
    log.warn(
      `${settingsPath} is not valid JSON, so no hippo hooks were removed from it: ${err.message}`,
      errorFields(err),
    );
    return undefined;
  }
}

/** Removes hippo's own hook handlers from `target`'s settings file and keeps every other handler; true when the file
 * changed. */
export function uninstallJsonHooks(target: JsonHookTarget): boolean {
  const { settings: settingsPath } = resolveJsonHookPaths(target);
  if (!fs.existsSync(settingsPath)) return false;
  if (target === 'copilot') {
    // Copilot reads every file in its hooks folder, so hippo's own file goes whole and the user's files stay.
    fs.rmSync(settingsPath, { force: true });
    return true;
  }
  const settings = readForRemoval(settingsPath);
  if (settings === undefined) return false;
  const plan = planHookRemoval(target, settings);
  if (plan.kept.length > 0) {
    process.stderr.write(
      `hippo kept these hook handlers in ${settingsPath} because they do not start with a hippo command; ` +
        `remove any that are hippo's by hand: ${plan.kept.map((c) => JSON.stringify(c)).join(', ')}\n`,
    );
  }
  if (plan.write === null) return false;
  writeSettingsFile(settingsPath, plan.write);
  return true;
}

/** Whether uninstall can edit settings.json; `invalidJson` marks a file that exists but is not JSON hippo can edit,
 * which `uninstallJsonHooks` reports only as false. */
export function checkUninstallable(target: JsonHookTarget): Pick<InstallResult, 'settingsPath' | 'invalidJson'> {
  const { settings: settingsPath } = resolveJsonHookPaths(target);
  if (!fs.existsSync(settingsPath)) return { settingsPath, invalidJson: false };
  return { settingsPath, invalidJson: !canEditHooks(tryReadJsonFile(settingsPath)) };
}
