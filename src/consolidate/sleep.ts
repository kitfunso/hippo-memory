/**
 * Consolidation engine ("Sleep") for Hippo.
 *
 * Steps:
 * 1. Decay pass  - remove entries below strength threshold
 * 2. Merge pass  - find episodic entries with high text overlap, create semantic summaries
 * 3. Stats tracking
 */

import { evalNow } from '../core/ablation.js';
import { MemoryEntry, canAutoDelete, type DecayOptions } from '../core/memory.js';
import { loadAllEntriesWithBase } from '../store/entry-reads.js';
import { commitInChunks, memoriesBackingObjects, type LoadedRows } from '../store/delete-and-batch.js';
import { appendConsolidationRun, loadSessionDecayContext, incrementSleepCount } from '../store/index-and-stats.js';
import { replaceDetectedConflicts } from '../store/conflicts.js';
import { SLEEP_DB_WAIT_MS } from '../db/index.js';
import { expireDormantBefore } from '../store/dormant.js';
import { loadConfig } from '../core/config.js';
import { type AppendAuditOpts, recordAuditEventsRowByRow, reportAuditWriteFailure } from '../store/audit.js';
import { lazyTombstoneChecks } from '../store/tombstone-checks.js';
import { migrateDefaultHalfLife, LEGACY_TYPED_HALF_LIFE } from './half-life-migration.js';
import { errorMessage, log } from '../util/log.js';
import { WRITE_BUDGET, type WriteBudget } from '../util/write-budget.js';
import { type DecayOutcome, decayPass } from './decay.js';
import { familyUnits, groupFlush } from './flush-units.js';
import { retireHeldTexts, mergePass } from './merge.js';
import { detectConflicts } from './conflicts.js';
import { type ConsolidationResult, type SleepRun, newConsolidationResult, syncFtsIndex } from './run.js';
import { promoteSessionTraces, replayPass } from './traces.js';
import { llmPasses } from './llm-passes.js';
import { physicsPass } from './physics-pass.js';
import { DAY_MS } from '../util/time.js';

/**
 * Run a full consolidation pass.
 */
export async function consolidate(
  hippoRoot: string,
  options: { dryRun?: boolean; now?: Date; fetcher?: typeof fetch; budget?: WriteBudget } = {}
): Promise<ConsolidationResult> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const dryRun = options.dryRun ?? false;
  const result = newConsolidationResult(dryRun);
  const halfLife = migrateHalfLives(hippoRoot, dryRun, result);
  syncFtsIndex(hippoRoot, dryRun, result);

  // Host-wide by design: per-tenant filtering would mean N runs per host and no cross-tenant dedup.
  // The api.sleep audit row tags this with the admin synthetic actor.
  const { entries: all, base: snapshot } = loadAllEntriesWithBase(hippoRoot);
  if (dryRun) for (const e of all) e.half_life_days = halfLife.halfLives.get(e.id) ?? e.half_life_days;
  const backingObjects = memoriesBackingObjects(hippoRoot);
  // Retirable: auto-deletable (never pinned, raw or kept for good) and not backing a first-class object.
  const retirable = (entry: MemoryEntry): boolean => canAutoDelete(entry) && !backingObjects.has(entry.id);

  const config = loadConfig(hippoRoot);
  const decayOpts = sessionDecayOptions(hippoRoot, config);

  const run: SleepRun = {
    hippoRoot, now, dryRun, config, decayOpts, result, all, retirable,
    tombstones: lazyTombstoneChecks(hippoRoot, dryRun),
    survivors: [],
    // Collect all writes/deletes and batch them at the end
    pendingWrites: [],
    pendingDeletes: [],
    pendingDormant: [],
    units: [],
  };

  const decay = decayPass(run);
  await runPassesAfterDecay(run, options.fetcher);

  const budget = options.budget ?? WRITE_BUDGET;
  await flushPending(run, snapshot, budget);
  await expireDormant(run, budget);
  if (!dryRun) logRun(run, decay);
  return result;
}

// Load decay options from config + session context
function sessionDecayOptions(hippoRoot: string, config: SleepRun['config']): DecayOptions {
  const sessionCtx = loadSessionDecayContext(hippoRoot);
  return {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
  };
}

/** Every pass between decay and the flush; the tombstone-check handle closes whichever of them throws. */
async function runPassesAfterDecay(run: SleepRun, fetcher: typeof fetch | undefined): Promise<void> {
  let mergesSkippedRejected = 0;
  try {
    promoteSessionTraces(run);
    replayPass(run);
    await llmPasses(run, fetcher);
    physicsPass(run);
    retireHeldTexts(run);
    mergesSkippedRejected = mergePass(run);
  } finally {
    run.tombstones.close();
  }

  if (mergesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${mergesSkippedRejected} merge(s) whose content matches a rejected value`,
    );
  }
}

// A changed default half-life moves memories still on the old base first,
// so this pass decays them at the new one (src/consolidate/half-life-migration.ts).
function migrateHalfLives(hippoRoot: string, dryRun: boolean, result: ConsolidationResult): ReturnType<typeof migrateDefaultHalfLife> {
  const halfLife = migrateDefaultHalfLife(hippoRoot, loadConfig(hippoRoot).defaultHalfLifeDays, { dryRun });
  if (halfLife.rescaled > 0) {
    result.details.push(
      `  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.rescaled} memories from the ${halfLife.from}-day to the ${halfLife.to}-day half-life`
    );
  }
  if (halfLife.typed > 0) {
    result.details.push(`  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.typed} memories of decisions, incidents and other objects from the ${LEGACY_TYPED_HALF_LIFE}-day to the ${halfLife.to}-day half-life`);
  }
  return halfLife;
}

async function flushPending(run: SleepRun, snapshot: LoadedRows, budget: WriteBudget): Promise<void> {
  const { result, pendingWrites, pendingDeletes, pendingDormant } = run;
  result.removedIds = pendingDeletes;
  if (run.dryRun) return;
  const units = [...run.units, ...familyUnits(pendingWrites, pendingDeletes, pendingDormant, snapshot)];
  const components = groupFlush(pendingWrites, pendingDeletes, pendingDormant, units);
  // The snapshot keeps what the DAG passes and other writers changed while sleep ran; the wait is sleep's own, not a server request's 250 ms.
  const left = new Set(await commitInChunks(run.hippoRoot, components, { snapshot, budget, busyWaitMs: SLEEP_DB_WAIT_MS }));
  for (const id of [...pendingDeletes, ...pendingDormant.map((m) => m.entry.id)]) {
    if (!left.has(id)) result.details.push(`  ↩  ${id} not removed: pinned or already gone before sleep saved`);
  }
  result.removedIds = pendingDeletes.filter((id) => left.has(id));
  result.removed = result.removedIds.length;
  result.dormant = pendingDormant.filter((m) => left.has(m.entry.id)).length;
}

// Dormant retention: a dormant memory nobody restored within
// dormant.retentionDays is deleted for good (0 keeps them forever). Runs
// even when dormant.enabled is off, so turning it off still ages out what
// earlier sleeps kept.
async function expireDormant(run: SleepRun, budget: WriteBudget): Promise<void> {
  const { config, result, dryRun } = run;
  if (!(config.dormant.retentionDays > 0)) return;
  const cutoff = new Date(run.now.getTime() - config.dormant.retentionDays * DAY_MS).toISOString();
  result.dormantExpired = await expireDormantBefore(run.hippoRoot, cutoff, { dryRun, budget, busyWaitMs: SLEEP_DB_WAIT_MS });
  if (result.dormantExpired > 0) {
    result.details.push(`  ⌛ ${dryRun ? 'would expire' : 'expired'} ${result.dormantExpired} dormant memor${result.dormantExpired === 1 ? 'y' : 'ies'} older than ${config.dormant.retentionDays} days`);
  }
}

// -------------------------------------------------------------------------
// 4. Log run
// -------------------------------------------------------------------------
function logRun(run: SleepRun, decay: DecayOutcome): void {
  const { hippoRoot, now, result } = run;
  const detectedConflicts = detectConflicts(run.survivors, now, run.decayOpts, decay.rescuedIds);
  replaceDetectedConflicts(hippoRoot, detectedConflicts, now.toISOString());

  if (detectedConflicts.length > 0) {
    result.details.push(`  ⚠️ detected ${detectedConflicts.length} memory conflict${detectedConflicts.length === 1 ? '' : 's'}`);
  }

  appendConsolidationRun(hippoRoot, {
    timestamp: now.toISOString(),
    decayed: result.decayed,
    merged: result.merged,
    removed: result.removed,
  });
  incrementSleepCount(hippoRoot);
  if (decay.rescuedEntries.length > 0) auditRescues(run, decay);
}

// One audit row per rescue, written only after the last flush chunk commits, so a run stopped mid-flush asserts no rescue.
function auditRescues(run: SleepRun, { rescuedEntries, rankById }: DecayOutcome): void {
  const { result } = run;
  const rescueEvent = (entry: MemoryEntry): AppendAuditOpts => {
    const rank = rankById.get(entry.id);
    return {
      tenantId: entry.tenantId,
      actor: 'sleep',
      op: 'mv_rescue',
      targetId: entry.id,
      metadata: rank
        ? { rank: rank.rank, totalNonPinned: rank.totalNonPinned, keepN: rank.keepN, score: rank.score }
        : {},
    };
  };
  try {
    // Row by row: one failed audit write must not silently drop every remaining row.
    const failed = recordAuditEventsRowByRow(run.hippoRoot, rescuedEntries.map(rescueEvent));
    for (const { event, error } of failed) reportAuditWriteFailure('mv_rescue', String(error), event.targetId);
    const auditFailures = failed.length;
    if (auditFailures > 0) {
      result.details.push(
        `  ⚠️ memory-value: ${auditFailures} mv_rescue audit row${auditFailures === 1 ? '' : 's'} ` +
        `failed to write (the rescue itself still landed)`,
      );
    }
  } catch (err) {
    // An audit store that will not open must never crash the mutation it records.
    log.debug(`mv_rescue audit unavailable: ${errorMessage(err)}`);
    result.details.push(
      `  ⚠️ memory-value: mv_rescue audit unavailable this cycle ` +
      `(${rescuedEntries.length} rescue${rescuedEntries.length === 1 ? '' : 's'} not audited)`,
    );
  }
}
