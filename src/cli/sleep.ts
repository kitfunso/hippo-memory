// The `hippo sleep` verb; main() loads it lazily, since most invocations never sleep.

import * as path from 'path';
import * as fs from 'fs';
import { loadConfig } from '../core/config.js';
import { isGitRepo } from '../learn/autolearn.js';
import { importForStore, currentMachine } from '../agent-memories/sync.js';
import { replayCompactionsAt } from '../capture/compaction-record.js';
import * as api from '../api/index.js';
import { cliApiContext } from './api-context.js';
import { sleepResultLines } from './sleep-render.js';
import { errorMessage, log } from '../util/log.js';
import { teeStdStreams } from '../util/stream-tee.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../db/index.js';
import { repairOnceOnSleep } from '../sharing/project-merge.js';
import { type CliFlags, boolFlag, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit, learnFromRepo, runChurnStaleForRepo, skipLearnOnSharedStore } from './shared.js';
import { printAgentImport } from './print.js';
import { repairQualityOnceAt } from './quality-repair-once.js';
import { printError } from './output.js';

/** Runs `hippo sleep`; with `--log-file` it also tees its output to that file. */
export async function cmdSleep(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  // Tee stdout/stderr to a log file when --log-file is set; the SessionEnd hook uses it so the SessionStart hook can re-display the output.
  const logFile = stringFlag(flags, 'log-file') ?? null;
  let restoreStdout: (() => void) | null = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `[hippo] ${new Date().toISOString()} consolidating memory...\n`, 'utf8');
      restoreStdout = teeStdStreams(logFile);
    } catch (err) {
      log.warn(`could not open log file ${logFile}: ${errorMessage(err)}`);
    }
  }

  try {
    await cmdSleepCore(hippoRoot, tenantId, flags);
    if (logFile) console.log('[hippo] sleep complete');
  } catch (err) {
    if (logFile) console.log(`[hippo] sleep failed: ${errorMessage(err)}`);
    throw err;
  } finally {
    if (restoreStdout) restoreStdout();
  }
}

export function handleSleep({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  return cmdSleep(hippoRoot, tenantId, flags);
}

function renderSleepResult(result: api.SleepResult): void {
  for (const line of sleepResultLines(result)) console.log(line);
}

/** Fault-isolated: a failed repair warns and runs again next sleep, and never stops the sleep. */
function repairProjectTagsOnce(hippoRoot: string, tenantId: string): void {
  let db: DatabaseSyncLike | undefined;
  try {
    db = openHippoDb(hippoRoot);
    const r = repairOnceOnSleep(db, hippoRoot, tenantId);
    if (r === null) return;
    const parts = [
      r.copies.length > 0 ? `set aside ${r.copies.length} misfiled note imports` : '',
      r.folds.length > 0 ? `folded ${r.folds.map((f) => `${f.from} into ${f.into}`).join(', ')}` : '',
      r.toProject.length + r.setAside.length > 0 ? `re-tagged ${r.toProject.length + r.setAside.length} merged memories` : '',
    ].filter((p) => p !== '');
    console.log(`Repaired project tags once after the upgrade: ${parts.join('; ')} (backup: ${r.backup}).`);
  } catch (err) {
    log.warn(`project tag repair skipped, retried next sleep: ${errorMessage(err)}`);
  } finally {
    if (db) closeHippoDb(db);
  }
}

async function cmdSleepCore(
  hippoRoot: string,
  tenantId: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);

  // Phase 1: Auto-learn from git and every coding agent's own memories (CLI-only, uses process.cwd() / os.homedir()).
  // Stays in cli.ts; api.sleep covers Phase 2-6 only.
  const learn = !flags['no-learn'] && !skipLearnOnSharedStore(hippoRoot);
  if (learn && flags['dry-run']) {
    console.log("Dry run: skipped learning from git commits and coding agents' own memories (`hippo import --agents --dry-run` previews those).");
  } else if (learn) {
    const config = loadConfig(hippoRoot);
    if (config.autoLearnOnSleep && isGitRepo(process.cwd())) {
      const { added } = learnFromRepo(hippoRoot, process.cwd(), 1);
      if (added > 0) console.log(`Auto-learned ${added} lessons from today's git commits.`);
    }

    // Opt-in code-churn staleness, off by default (config.churnStaleness.enabled).
    if (config.churnStaleness.enabled && isGitRepo(process.cwd())) {
      for (const { root, result } of runChurnStaleForRepo(hippoRoot, false)) {
        if (result.marked > 0) console.log(`Tagged ${result.marked} memories churn-stale in ${root}.`);
        if (result.error) printError(`Churn-staleness check failed for ${root}: ${result.error}`);
      }
    }

    printAgentImport(importForStore(hippoRoot, { machine: currentMachine() }), '');
  }

  // Finishes compactions a killed or busy post-compact hook left; never throws, and a dry run writes nothing.
  if (!flags['dry-run']) {
    const finished = replayCompactionsAt(hippoRoot, (message) => log.warn(`compaction replay: ${message}`));
    if (finished > 0) console.log(`Finished saving ${finished} compaction${finished === 1 ? '' : 's'} left over from earlier sessions.`);
    repairProjectTagsOnce(hippoRoot, tenantId);
    repairQualityOnceAt(hippoRoot);
  }

  // Phase 2-6: Pure-storage pipeline (consolidate + dedup + audit + share + ambient).
  const ctx = cliApiContext(hippoRoot, tenantId);
  const result = await api.sleep(ctx, {
    dryRun: boolFlag(flags, 'dry-run'),
    noShare: boolFlag(flags, 'no-share'),
  });
  renderSleepResult(result);
}
