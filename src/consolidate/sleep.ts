/**
 * Consolidation engine ("Sleep") for Hippo.
 *
 * Steps:
 * 1. Decay pass  - remove entries below strength threshold
 * 2. Merge pass  - find episodic entries with high text overlap, create semantic summaries
 * 3. Stats tracking
 */

import { evalNow } from '../ablation.js';
import { MemoryEntry, canAutoDelete, type DecayOptions } from '../memory.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { batchWriteAndDeleteOn, type FlushComponent, memoriesBackingObjects, noteFailedUnit } from '../store/delete-and-batch.js';
import { openStore } from '../store/open.js';
import { appendConsolidationRun, loadSessionDecayContext, incrementSleepCount } from '../store/index-and-stats.js';
import { replaceDetectedConflicts } from '../store/conflicts.js';
import { openHippoDb, closeHippoDb, SLEEP_DB_WAIT_MS, withWriteScope, type DatabaseSyncLike } from '../db.js';
import { deleteExpiredDormantRow, type DormantKey, expiredDormantKeys } from '../store/dormant.js';
import { loadConfig } from '../config.js';
import { appendAuditEvent, reportAuditWriteFailure } from '../store/audit.js';
import { migrateDefaultHalfLife, LEGACY_TYPED_HALF_LIFE } from '../half-life-migration.js';
import { errorMessage, log } from '../log.js';
import { WRITE_BUDGET, type WriteBudget } from '../write-budget.js';
import { type DecayOutcome, decayPass } from './decay.js';
import { familyUnits, groupFlush } from './flush-units.js';
import { retireHeldTexts, mergePass } from './merge.js';
import { detectConflicts } from './conflicts.js';
import { type ConsolidationResult, lazyConsolidateDb, type SleepRun, newConsolidationResult, syncFtsIndex } from './run.js';
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
  const all = loadAllEntries(hippoRoot);
  if (dryRun) for (const e of all) e.half_life_days = halfLife.halfLives.get(e.id) ?? e.half_life_days;
  const backingObjects = memoriesBackingObjects(hippoRoot);
  // Retirable: auto-deletable (never pinned, raw or kept for good) and not backing a first-class object.
  const retirable = (entry: MemoryEntry): boolean => canAutoDelete(entry) && !backingObjects.has(entry.id);
  const snapshot = new Map(structuredClone(all).map((e) => [e.id, e]));

  const config = loadConfig(hippoRoot);
  const decayOpts = sessionDecayOptions(hippoRoot, config);

  const consolidateDb = lazyConsolidateDb(hippoRoot, dryRun);
  const run: SleepRun = {
    hippoRoot, now, dryRun, config, decayOpts, result, all, retirable,
    getConsolidateDb: consolidateDb.get,
    survivors: [],
    // Collect all writes/deletes and batch them at the end
    pendingWrites: [],
    pendingDeletes: [],
    pendingDormant: [],
    units: [],
  };

  const decay = decayPass(run);
  await runPassesAfterDecay(run, consolidateDb.close, options.fetcher);

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
async function runPassesAfterDecay(run: SleepRun, closeConsolidateDb: () => void, fetcher: typeof fetch | undefined): Promise<void> {
  let mergesSkippedRejected = 0;
  try {
    promoteSessionTraces(run);
    replayPass(run);
    await llmPasses(run, fetcher);
    physicsPass(run);
    retireHeldTexts(run);
    mergesSkippedRejected = mergePass(run);
  } finally {
    closeConsolidateDb();
  }

  if (mergesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${mergesSkippedRejected} merge(s) whose content matches a rejected value`,
    );
  }
}

// A changed default half-life moves memories still on the old base first,
// so this pass decays them at the new one (src/half-life-migration.ts).
function migrateHalfLives(hippoRoot: string, dryRun: boolean, result: ConsolidationResult): ReturnType<typeof migrateDefaultHalfLife> {
  const halfLife = migrateDefaultHalfLife(hippoRoot, loadConfig(hippoRoot).defaultHalfLifeDays, { dryRun });
  if (halfLife.rescaled > 0) {
    result.details.push(`  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.rescaled} memories from the ${halfLife.from}-day to the ${halfLife.to}-day half-life`);
  }
  if (halfLife.typed > 0) {
    result.details.push(`  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.typed} memories of decisions, incidents and other objects from the ${LEGACY_TYPED_HALF_LIFE}-day to the ${halfLife.to}-day half-life`);
  }
  return halfLife;
}

async function flushPending(run: SleepRun, snapshot: Map<string, MemoryEntry>, budget: WriteBudget): Promise<void> {
  const { result, pendingWrites, pendingDeletes, pendingDormant } = run;
  result.removedIds = pendingDeletes;
  if (run.dryRun) return;
  const units = [...run.units, ...familyUnits(pendingWrites, pendingDeletes, pendingDormant, snapshot)];
  const components = groupFlush(pendingWrites, pendingDeletes, pendingDormant, units);
  const left = new Set(await commitInChunks(run.hippoRoot, components, snapshot, budget));
  for (const id of [...pendingDeletes, ...pendingDormant.map((m) => m.entry.id)]) {
    if (!left.has(id)) result.details.push(`  ↩  ${id} not removed: pinned or already gone before sleep saved`);
  }
  result.removedIds = pendingDeletes.filter((id) => left.has(id));
  result.removed = result.removedIds.length;
  result.dormant = pendingDormant.filter((m) => left.has(m.entry.id)).length;
}

/** Commits whole components in transactions of about `budget.holdMs`, letting other writers in between; returns the ids that left `memories`.
 *  The snapshot keeps what the DAG passes and other writers changed while sleep ran. */
async function commitInChunks(
  hippoRoot: string,
  components: readonly FlushComponent[],
  snapshot: ReadonlyMap<string, MemoryEntry>,
  budget: WriteBudget,
): Promise<string[]> {
  if (components.length === 0) return [];
  const removed: string[] = [];
  // Its own wait, not a server request's 250 ms, and an option rather than a PRAGMA so a shared hook handle keeps its own.
  const db = openStore(hippoRoot, { busyWaitMs: SLEEP_DB_WAIT_MS });
  let next = 0;
  try {
    let committedAt = 0;
    while (next < components.length) {
      if (next > 0) await budget.pause(committedAt);
      const chunk = batchWriteAndDeleteOn(db, hippoRoot, components, next, { snapshot, holdMs: budget.holdMs, clock: budget.clock });
      committedAt = budget.clock();
      next = chunk.next;
      for (const id of chunk.removedIds) removed.push(id);
    }
  } catch (err) {
    // A unit that threw is already tagged; a throw outside one (a pause, BEGIN or COMMIT) names the chunk's first unit.
    if (err instanceof Error) noteFailedUnit(err, components[next]);
    throw err;
  } finally {
    closeHippoDb(db);
  }
  return removed;
}

/** Deletes `keys` in transactions of about `budget.holdMs`, letting other writers in between; returns how many went. */
async function expireInChunks(db: DatabaseSyncLike, keys: readonly DormantKey[], cutoff: string, budget: WriteBudget): Promise<number> {
  let gone = 0;
  let next = 0;
  let committedAt = 0;
  while (next < keys.length) {
    if (next > 0) await budget.pause(committedAt);
    withWriteScope(db, 'expire_dormant_chunk', () => {
      const begunAt = budget.clock();
      do gone += deleteExpiredDormantRow(db, keys[next++], cutoff);
      while (next < keys.length && budget.clock() - begunAt < budget.holdMs);
    });
    committedAt = budget.clock();
  }
  return gone;
}

// Dormant retention: a dormant memory nobody restored within
// dormant.retentionDays is deleted for good (0 keeps them forever). Runs
// even when dormant.enabled is off, so turning it off still ages out what
// earlier sleeps kept.
async function expireDormant(run: SleepRun, budget: WriteBudget): Promise<void> {
  const { config, result, dryRun } = run;
  if (!(config.dormant.retentionDays > 0)) return;
  const cutoff = new Date(run.now.getTime() - config.dormant.retentionDays * DAY_MS).toISOString();
  const db = openHippoDb(run.hippoRoot, { busyWaitMs: SLEEP_DB_WAIT_MS });
  try {
    // The keys come from a read, so a sleep with nothing to expire never takes the write lock; one DELETE scanned every stored entry under it.
    const keys = expiredDormantKeys(db, cutoff);
    result.dormantExpired = dryRun ? keys.length : await expireInChunks(db, keys, cutoff, budget);
  } finally {
    closeHippoDb(db);
  }
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
  try {
    const auditDb = openHippoDb(run.hippoRoot);
    try {
      // Per-row try/catch: one failed appendAuditEvent must not silently drop every remaining row.
      let auditFailures = 0;
      for (const entry of rescuedEntries) {
        try {
          const rank = rankById.get(entry.id);
          appendAuditEvent(auditDb, {
            tenantId: entry.tenantId,
            actor: 'sleep',
            op: 'mv_rescue',
            targetId: entry.id,
            metadata: rank
              ? { rank: rank.rank, totalNonPinned: rank.totalNonPinned, keepN: rank.keepN, score: rank.score }
              : {},
          });
        } catch (error) {
          auditFailures++;
          reportAuditWriteFailure('mv_rescue', String(error), entry.id);
        }
      }
      if (auditFailures > 0) {
        result.details.push(
          `  ⚠️ memory-value: ${auditFailures} mv_rescue audit row${auditFailures === 1 ? '' : 's'} ` +
          `failed to write (the rescue itself still landed)`,
        );
      }
    } finally {
      closeHippoDb(auditDb);
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
