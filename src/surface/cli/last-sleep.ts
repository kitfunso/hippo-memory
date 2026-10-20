// `hippo last-sleep`: the previous session's sleep log for the debug log, and one problems line for the user.
import * as fs from 'fs';
import { REPLAY_AFTER_MS } from '../../base/session/compaction-timing.js';
import { SPOOL_PROBLEM, spoolCounts } from '../capture/compaction-spool.js';
import { defaultSleepLogPath } from '../hooks-install/json-hooks.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { ignoringCodes, PATH_UNREADABLE } from '../../base/util/expected-errors.js';
import { truncateCodePointSafe } from '../../base/util/transcript-tail.js';
import { printError } from './output.js';
import { type CommandContext, boolFlag, stringFlag } from './flag-values.js';
import { hookStoreRoot } from './hook-runtime.js';
import { plural } from '../../base/util/format.js';

const SLEEP_FAILED = '[hippo] sleep failed: ';
const FAILURE_CHARS = 120;

/**
 * The line the user sees when the last sleep failed, a spool step hit an unexpected error, or the spool holds `.bad`
 * files; null when none did.
 */
export function sleepProblems(logText: string, bad: number): string | null {
  const lines = logText.split(/\r?\n/);
  const failed = lines.find((line) => line.startsWith(SLEEP_FAILED));
  const errors = lines.filter((line) => line.includes(SPOOL_PROBLEM)).length;
  const parts = [
    failed === undefined
      ? ''
      : `the last sleep failed (${truncateCodePointSafe(failed.slice(SLEEP_FAILED.length).trim(), FAILURE_CHARS)})`,
    errors === 0 ? '' : `${plural(errors, 'error')} while saving waiting compaction summaries`,
    bad === 0 ? '' : `${bad} compaction ${bad === 1 ? 'summary' : 'summaries'} set aside as .bad`,
  ].filter((part) => part !== '');
  return parts.length === 0 ? null : `Hippo: ${parts.join('; ')}. Run hippo doctor for details.`;
}

function badSpoolFiles(hippoRoot: string): number {
  try {
    return spoolCounts(hookStoreRoot(hippoRoot), new Date(), REPLAY_AFTER_MS).bad;
  } catch (err) {
    printError(`hippo: spool not counted: ${errorMessage(err)}`);
    return 0;
  }
}

/** Prints the SessionEnd sleep log on stderr, then clears it. In a hook, stdout carries only `systemMessage`, because
 *  Claude Code shows that to the user and adds any other SessionStart stdout to the model's context. */
export function handleLastSleep(
  { hippoRoot, flags }: Pick<CommandContext, 'hippoRoot' | 'flags'>,
  out: 'hook' | 'terminal' = process.stdout.isTTY ? 'terminal' : 'hook',
): void {
  const logPath = stringFlag(flags, 'path') ?? defaultSleepLogPath();

  if (!fs.existsSync(logPath)) return;

  // Removed or locked since the exists check: there is nothing to show this session.
  const content = ignoringCodes([...PATH_UNREADABLE, 'EBUSY'], () => fs.readFileSync(logPath, 'utf8'));
  if (content === undefined) return;

  if (content.trim().length > 0) {
    printError('=== Previous session hippo consolidation ===');
    process.stderr.write(content);
    if (!content.endsWith('\n')) printError();
    printError('===========================================');
  }

  const problems = sleepProblems(content, badSpoolFiles(hippoRoot));
  if (problems !== null && out === 'hook') process.stdout.write(`${JSON.stringify({ systemMessage: problems })}\n`);
  if (problems !== null && out === 'terminal') printError(problems);

  if (!boolFlag(flags, 'keep')) {
    try {
      fs.unlinkSync(logPath);
    } catch (err) {
      log.debug(`last-sleep log not removed, it shows again next session: ${errorMessage(err)}`, errorFields(err));
    }
  }
}
