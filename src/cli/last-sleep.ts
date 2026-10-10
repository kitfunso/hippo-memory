// `hippo last-sleep`: the previous session's sleep log for the debug log, and one problems line for the user.
import * as fs from 'fs';
import { isStringValue } from '../core/capture-contract.js';
import { REPLAY_AFTER_MS } from '../core/compaction-timing.js';
import { SPOOL_PROBLEM, spoolCounts } from '../capture/compaction-spool.js';
import { defaultSleepLogPath } from '../hooks/shared.js';
import { errorMessage, log } from '../util/log.js';
import { truncateCodePointSafe } from '../util/transcript-tail.js';
import { printError } from './output.js';
import { type CliFlags, type CommandContext } from './flag-values.js';
import { hookStoreRoot } from './hook-runtime.js';

const SLEEP_FAILED = '[hippo] sleep failed: ';
const FAILURE_CHARS = 120;

/** The line the user sees when the last sleep failed, a spool step hit an unexpected error, or the spool holds `.bad` files; null when none did. */
export function sleepProblems(logText: string, bad: number): string | null {
  const lines = logText.split(/\r?\n/);
  const failed = lines.find((line) => line.startsWith(SLEEP_FAILED));
  const errors = lines.filter((line) => line.includes(SPOOL_PROBLEM)).length;
  const parts = [
    failed === undefined ? '' : `the last sleep failed (${truncateCodePointSafe(failed.slice(SLEEP_FAILED.length).trim(), FAILURE_CHARS)})`,
    errors === 0 ? '' : `${errors} error${errors === 1 ? '' : 's'} while saving waiting compaction summaries`,
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

/** Prints the SessionEnd sleep log on stderr, then clears it. In a hook, stdout carries only `systemMessage`,
 *  because Claude Code shows that to the user and adds any other SessionStart stdout to the model's context. */
export function cmdLastSleep(
  hippoRoot: string,
  flags: CliFlags,
  out: 'hook' | 'terminal' = process.stdout.isTTY ? 'terminal' : 'hook',
): void {
  const pathFlag = flags['path'];
  const logPath = isStringValue(pathFlag) ? pathFlag : defaultSleepLogPath();

  if (!fs.existsSync(logPath)) return;

  let content: string;
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch {
    // Removed or locked since the exists check: there is nothing to show this session.
    return;
  }

  if (content.trim().length > 0) {
    printError('=== Previous session hippo consolidation ===');
    process.stderr.write(content);
    if (!content.endsWith('\n')) printError();
    printError('===========================================');
  }

  const problems = sleepProblems(content, badSpoolFiles(hippoRoot));
  if (problems !== null && out === 'hook') process.stdout.write(`${JSON.stringify({ systemMessage: problems })}\n`);
  if (problems !== null && out === 'terminal') printError(problems);

  if (!flags['keep']) {
    try { fs.unlinkSync(logPath); } catch (err) { log.debug(`last-sleep log not removed, it shows again next session: ${errorMessage(err)}`); }
  }
}

export function handleLastSleep({ hippoRoot, flags }: CommandContext): void {
  return cmdLastSleep(hippoRoot, flags);
}
