/**
 * Consolidation engine ("Sleep"): decay pass (drop entries below the strength threshold), merge pass (semantic
 * summaries of overlapping episodics), stats.
 */

import { evalNow, strengthAblation } from '../core/ablation.js';
import { MemoryEntry, canAutoDelete, LEGACY_TYPED_HALF_LIFE, type DecayOptions } from '../core/memory.js';
import type { LoadedRows } from '../store/delete-and-batch.js';
import type { AppendAuditOpts } from '../store/audit.js';
import type { Consolidation, LocalFiles } from '../store/port.js';
import { sqliteSyncStore } from '../store/sqlite/store.js';
import { loadConfig } from '../core/config.js';
import { migrateDefaultHalfLife } from './half-life-migration.js';
import { errorFields, errorMessage, log } from '../util/log.js';
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

type ConsolidateOptions = { dryRun?: boolean; now?: Date; fetcher?: typeof fetch; budget?: WriteBudget };

/**
 * Run a full consolidation pass on the hippo.db under `hippoRoot`.
 */
export async function consolidate(hippoRoot: string, options: ConsolidateOptions = {}): Promise<ConsolidationResult> {
  return runConsolidation(sqliteSyncStore(hippoRoot).localFiles, options);
}

/** A full consolidation pass whose store work goes through `local.consolidation`. */
export async function runConsolidation(
  local: LocalFiles,
  options: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const { hippoRoot, consolidation: store } = local;
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const dryRun = options.dryRun ?? false;
  const result = newConsolidationResult(dryRun);
  const halfLife = migrateHalfLives(local, dryRun, result);
  syncFtsIndex(store, dryRun, result);

  // Host-wide by design: per-tenant filtering would mean N runs per host and no cross-tenant dedup.
  // The api.sleep audit row tags this with the admin synthetic actor.
  const { entries: all, base: snapshot } = store.entriesWithBase();
  if (dryRun) for (const e of all) e.half_life_days = halfLife.halfLives.get(e.id) ?? e.half_life_days;
  const backingObjects = store.objectBackedIds();
  // Retirable: auto-deletable (never pinned, raw or kept for good) and not backing a first-class object.
  const retirable = (entry: MemoryEntry): boolean => canAutoDelete(entry) && !backingObjects.has(entry.id);

  const config = loadConfig(hippoRoot);
  const decayOpts = sessionDecayOptions(store, config);

  const run: SleepRun = {
    hippoRoot, store, now, dryRun, config, decayOpts, result, all, retirable,
    tombstones: store.tombstoneChecks(dryRun),
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
function sessionDecayOptions(store: Consolidation, config: SleepRun['config']): DecayOptions {
  const sessionCtx = store.sessionDecayContext();
  return {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
    ablation: strengthAblation(),
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
function migrateHalfLives(
  local: LocalFiles,
  dryRun: boolean,
  result: ConsolidationResult,
): ReturnType<typeof migrateDefaultHalfLife> {
  const to = loadConfig(local.hippoRoot).defaultHalfLifeDays;
  const halfLife = migrateDefaultHalfLife(local.consolidation, to, { dryRun });
  if (halfLife.rescaled > 0) {
    result.details.push(
      `  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.rescaled} memories from the ${halfLife.from}-day to the ` +
      `${halfLife.to}-day half-life`,
    );
  }
  if (halfLife.typed > 0) {
    result.details.push(
      `  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.typed} memories of decisions, incidents and other objects ` +
        `from the ${LEGACY_TYPED_HALF_LIFE}-day to the ${halfLife.to}-day half-life`,
    );
  }
  return halfLife;
}

async function flushPending(run: SleepRun, snapshot: LoadedRows, budget: WriteBudget): Promise<void> {
  const { result, pendingWrites, pendingDeletes, pendingDormant } = run;
  result.removedIds = pendingDeletes;
  if (run.dryRun) return;
  const units = [...run.units, ...familyUnits(pendingWrites, pendingDeletes, pendingDormant, snapshot)];
  const components = groupFlush(pendingWrites, pendingDeletes, pendingDormant, units);
  // The snapshot keeps what the DAG passes and other writers changed while sleep ran.
  const left = new Set(await run.store.commitFlush(components, { snapshot, budget }));
  for (const id of [...pendingDeletes, ...pendingDormant.map((m) => m.entry.id)]) {
    if (!left.has(id)) result.details.push(`  ↩  ${id} not removed: pinned or already gone before sleep saved`);
  }
  result.removedIds = pendingDeletes.filter((id) => left.has(id));
  result.removed = result.removedIds.length;
  result.dormant = pendingDormant.filter((m) => left.has(m.entry.id)).length;
}

// Dormant retention: a dormant memory nobody restored within dormant.retentionDays is deleted for good (0 keeps
// forever);
// runs even when dormant.enabled is off, so turning it off still ages out what earlier sleeps kept.
async function expireDormant(run: SleepRun, budget: WriteBudget): Promise<void> {
  const { config, result, dryRun } = run;
  if (!(config.dormant.retentionDays > 0)) return;
  const cutoff = new Date(run.now.getTime() - config.dormant.retentionDays * DAY_MS).toISOString();
  result.dormantExpired = await run.store.expireDormant(cutoff, { dryRun, budget });
  if (result.dormantExpired > 0) {
    result.details.push(
      `  ⌛ ${dryRun ? 'would expire' : 'expired'} ${result.dormantExpired} dormant ` +
      `memor${result.dormantExpired === 1 ? 'y' : 'ies'} ` +
        `older than ${config.dormant.retentionDays} days`,
    );
  }
}

// 4. Log run
function logRun(run: SleepRun, decay: DecayOutcome): void {
  const { store, now, result } = run;
  const detectedConflicts = detectConflicts(run.survivors, now, run.decayOpts, decay.rescuedIds);
  store.replaceConflicts(detectedConflicts, now.toISOString());

  if (detectedConflicts.length > 0) {
    result.details.push(
      `  ⚠️ detected ${detectedConflicts.length} memory conflict${detectedConflicts.length === 1 ? '' : 's'}`,
    );
  }

  store.recordRun({
    timestamp: now.toISOString(),
    decayed: result.decayed,
    merged: result.merged,
    removed: result.removed,
  });
  store.countSleep();
  if (decay.rescuedEntries.length > 0) auditRescues(run, decay);
}

// One audit row per rescue, written only after the last flush chunk commits, so a run stopped mid-flush asserts no
// rescue.
function auditRescues(run: SleepRun, { rescuedEntries, rankById }: DecayOutcome): void {
  const { result } = run;
  const rescueEvent = (entry: MemoryEntry): AppendAuditOpts => {
    const rank = rankById.get(entry.id);
    return {
      tenantId: entry.tenant_id,
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
    const auditFailures = run.store.auditEachRow(rescuedEntries.map(rescueEvent));
    if (auditFailures > 0) {
      result.details.push(
        `  ⚠️ memory-value: ${auditFailures} mv_rescue audit row${auditFailures === 1 ? '' : 's'} ` +
        `failed to write (the rescue itself still landed)`,
      );
    }
  } catch (err) {
    // An audit store that will not open must never crash the mutation it records.
    log.warn(`mv_rescue audit unavailable: ${errorMessage(err)}`, { errorClass: errorFields(err).errorClass });
    result.details.push(
      `  ⚠️ memory-value: mv_rescue audit unavailable this cycle ` +
      `(${rescuedEntries.length} rescue${rescuedEntries.length === 1 ? '' : 's'} not audited)`,
    );
  }
}
