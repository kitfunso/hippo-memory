// The `hippo sleep` verb; main() loads it lazily, since most invocations never sleep.

import * as path from 'path';
import * as fs from 'fs';
import { loadConfig } from '../config.js';
import { isGitRepo } from '../autolearn.js';
import { importForStore, currentMachine } from '../agent-memories/sync.js';
import { replayCompactionsAt } from '../compaction-record.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { renderAmbientSummary } from '../ambient.js';
import { requireInit, learnFromRepo, runChurnStaleForRepo, printAgentImport } from './shared.js';

/** Runs `hippo sleep`; with `--log-file` it also tees its output to that file. */
export async function cmdSleep(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  // Tee stdout/stderr to a log file when --log-file is set. The SessionEnd
  // hook uses this so the output is captured somewhere the SessionStart hook
  // can re-display it next time the agent UI starts.
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : null;
  let restoreStdout: (() => void) | null = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `[hippo] ${new Date().toISOString()} consolidating memory...\n`, 'utf8');
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      const tee = (chunk: unknown) => {
        try {
          const buf = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          fs.appendFileSync(logFile, buf, 'utf8');
        } catch {
          // log failures are non-fatal — still write to the real stream
        }
      };
      process.stdout.write = ((chunk: any, enc?: any, cb?: any): boolean => {
        tee(chunk);
        return origStdoutWrite(chunk, enc, cb);
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: any, enc?: any, cb?: any): boolean => {
        tee(chunk);
        return origStderrWrite(chunk, enc, cb);
      }) as typeof process.stderr.write;
      restoreStdout = () => {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
      };
    } catch (err) {
      console.error(`[hippo] warning: could not open log file ${logFile}: ${(err as Error).message}`);
    }
  }

  try {
    await cmdSleepCore(hippoRoot, flags);
    if (logFile) console.log('[hippo] sleep complete');
  } catch (err) {
    if (logFile) console.log(`[hippo] sleep failed: ${(err as Error).message}`);
    throw err;
  } finally {
    if (restoreStdout) restoreStdout();
  }
}

/**
 * Render an api.sleep result as console output, byte-identical to the
 * pre-extraction inline implementation in cmdSleepCore.
 */
/** @internal — exported for snapshot tests (tests/cli-context-render-snapshot.test.ts). NOT a stable public API. */
export function renderSleepResult(result: api.SleepResult): void {
  console.log(`Running consolidation${result.dryRun ? ' (dry run)' : ''}...`);

  console.log(`\nResults:`);
  console.log(`   Active memories:  ${result.active}`);
  console.log(`   Removed (decayed): ${result.removed}`);
  // Only when dormant.enabled moved something, so every other render stays
  // byte-identical (tests/cli-context-render-snapshot.test.ts).
  if (result.dormant !== undefined && result.dormant > 0) {
    console.log(`   Kept dormant:      ${result.dormant}  (hippo dormant to list)`);
  }
  if (result.dormantExpired !== undefined && result.dormantExpired > 0) {
    console.log(`   Expired dormant:   ${result.dormantExpired}  (past dormant.retentionDays)`);
  }
  console.log(`   Merged episodic:   ${result.mergedEpisodic}`);
  console.log(`   New semantic:      ${result.newSemantic}`);

  if (result.details && result.details.length > 0) {
    console.log('\nDetails:');
    for (const d of result.details) {
      console.log(d);
    }
  }

  if (result.dryRun) console.log('\n(dry run  - nothing written)');

  if (result.deduped && result.deduped.removed > 0) {
    const { removed, semDups, epiDups, crossDups } = result.deduped;
    const parts: string[] = [];
    if (semDups > 0) parts.push(`${semDups} redundant semantic patterns`);
    if (epiDups > 0) parts.push(`${epiDups} duplicate episodic lessons`);
    if (crossDups > 0) parts.push(`${crossDups} cross-layer duplicates`);
    console.log(`\n${result.dryRun ? 'Would dedupe' : 'Deduped'} ${removed} duplicates (${parts.join(', ')}). ${result.dryRun ? 'Would keep' : 'Kept'} stronger copies.`);
  }

  if (result.audit) {
    if (result.audit.errorsRemoved > 0) {
      console.log(`\nAudit: ${result.dryRun ? 'would remove' : 'removed'} ${result.audit.errorsRemoved} junk memories (too short/empty).`);
    }
    if (result.audit.warningCount > 0) {
      console.log(`Audit: ${result.audit.warningCount} low-quality memories detected (run \`hippo audit\` for details).`);
    }
  }

  if (result.shared !== undefined && result.shared > 0) {
    console.log(`\nAuto-shared ${result.shared} high-value memories to global store.`);
  }

  if (result.secretSkipped !== undefined && result.secretSkipped > 0) {
    // The secret veto is never silent.
    console.log(`\nAuto-share: withheld ${result.secretSkipped} secret-flagged ${result.secretSkipped === 1 ? 'memory' : 'memories'} (secret veto).`);
  }

  if (result.ambient) {
    console.log(`\n${renderAmbientSummary(result.ambient)}`);
  }

  if (result.graph && result.graph.tenants > 0) {
    const { tenants, entities, relations } = result.graph;
    console.log(
      `\nGraph: rebuilt ${tenants} tenant${tenants === 1 ? '' : 's'} (${entities} entities, ${relations} relations).`,
    );
  }
}

async function cmdSleepCore(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  // Phase 1: Auto-learn from git and every coding agent's own memories (CLI-only, uses process.cwd() / os.homedir()).
  // Stays in cli.ts; api.sleep covers Phase 2-6 only.
  if (!flags['no-learn'] && flags['dry-run']) {
    console.log("Dry run: skipped learning from git commits and coding agents' own memories (`hippo import --agents --dry-run` previews those).");
  } else if (!flags['no-learn']) {
    const config = loadConfig(hippoRoot);
    if (config.autoLearnOnSleep && isGitRepo(process.cwd())) {
      const { added } = learnFromRepo(hippoRoot, process.cwd(), 1);
      if (added > 0) console.log(`Auto-learned ${added} lessons from today's git commits.`);
    }

    // Opt-in code-churn staleness, off by default (config.churnStaleness.enabled).
    if (config.churnStaleness.enabled && isGitRepo(process.cwd())) {
      for (const { root, result } of runChurnStaleForRepo(hippoRoot, false)) {
        if (result.marked > 0) console.log(`Tagged ${result.marked} memories churn-stale in ${root}.`);
        if (result.error) console.error(`Churn-staleness check failed for ${root}: ${result.error}`);
      }
    }

    printAgentImport(importForStore(hippoRoot, { machine: currentMachine() }), '');
  }

  // Finishes compactions a killed or busy post-compact hook left; never throws, and a dry run writes nothing.
  if (!flags['dry-run']) {
    const finished = replayCompactionsAt(hippoRoot, (message) => console.error(`compaction replay: ${message}`));
    if (finished > 0) console.log(`Finished saving ${finished} compaction${finished === 1 ? '' : 's'} left over from earlier sessions.`);
  }

  // Phase 2-6: Pure-storage pipeline (consolidate + dedup + audit + share + ambient).
  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const result = await api.sleep(ctx, {
    dryRun: Boolean(flags['dry-run']),
    noShare: Boolean(flags['no-share']),
  });
  renderSleepResult(result);
}
