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
import { batchWriteAndDelete, memoriesBackingObjects } from '../store/delete-and-batch.js';
import { appendConsolidationRun, loadSessionDecayContext, incrementSleepCount } from '../store/index-and-stats.js';
import { replaceDetectedConflicts } from '../store/conflicts.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import { countExpiredDormant, purgeExpiredDormant } from '../dormant.js';
import { loadConfig } from '../config.js';
import { appendAuditEvent, reportAuditWriteFailure } from '../audit.js';
import { migrateDefaultHalfLife, LEGACY_TYPED_HALF_LIFE } from '../half-life-migration.js';
import { log } from '../log.js';
import { type DecayOutcome, decayPass } from './decay.js';
import { retireHeldTexts, mergePass } from './merge.js';
import { detectConflicts } from './conflicts.js';
import { type ConsolidationResult, lazyConsolidateDb, type SleepRun, newConsolidationResult, syncFtsIndex } from './run.js';
import { promoteSessionTraces, replayPass } from './traces.js';
import { llmPasses } from './llm-passes.js';
import { physicsPass } from './physics-pass.js';

/**
 * Run a full consolidation pass.
 */
export async function consolidate(
  hippoRoot: string,
  options: { dryRun?: boolean; now?: Date; fetcher?: typeof fetch } = {}
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

  // Load decay options from config + session context
  const config = loadConfig(hippoRoot);
  const sessionCtx = loadSessionDecayContext(hippoRoot);
  const decayOpts: DecayOptions = {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
  };

  const consolidateDb = lazyConsolidateDb(hippoRoot, dryRun);
  const run: SleepRun = {
    hippoRoot, now, dryRun, config, decayOpts, result, all, retirable,
    getConsolidateDb: consolidateDb.get,
    survivors: [],
    // Collect all writes/deletes and batch them at the end
    pendingWrites: [],
    pendingDeletes: [],
    pendingDormant: [],
  };

  const decay = decayPass(run);

  let mergesSkippedRejected = 0;
  try {
    promoteSessionTraces(run);
    replayPass(run);
    await llmPasses(run, options.fetcher);
    physicsPass(run);
    retireHeldTexts(run);
    mergesSkippedRejected = mergePass(run);
  } finally {
    consolidateDb.close();
  }

  if (mergesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${mergesSkippedRejected} merge(s) whose content matches a rejected value`,
    );
  }

  flushPending(run, snapshot);
  expireDormant(run);
  if (!dryRun) logRun(run, decay);
  return result;
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

function flushPending(run: SleepRun, snapshot: Map<string, MemoryEntry>): void {
  const { result, pendingDeletes, pendingDormant } = run;
  result.removedIds = pendingDeletes;
  // One transaction; the snapshot keeps what the DAG passes and other writers changed while sleep ran.
  // Dormant moves ride in the same transaction (src/dormant.ts).
  if (run.dryRun) return;
  const left = new Set(batchWriteAndDelete(run.hippoRoot, run.pendingWrites, pendingDeletes, { snapshot, dormant: pendingDormant }));
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
function expireDormant(run: SleepRun): void {
  const { config, result, dryRun } = run;
  if (!(config.dormant.retentionDays > 0)) return;
  const cutoff = new Date(run.now.getTime() - config.dormant.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const db = openHippoDb(run.hippoRoot);
  try {
    result.dormantExpired = dryRun ? countExpiredDormant(db, cutoff) : purgeExpiredDormant(db, cutoff);
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

// One audit row per rescue, written only after batchWriteAndDelete commits: writing earlier
// would assert rescues for a cycle whose effects never landed if a later phase threw.
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
  } catch {
    // openHippoDb/closeHippoDb-level failure: audit must never crash a
    // mutation (mirrors store.ts's audit() posture).
    result.details.push(
      `  ⚠️ memory-value: mv_rescue audit unavailable this cycle ` +
      `(${rescuedEntries.length} rescue${rescuedEntries.length === 1 ? '' : 's'} not audited)`,
    );
  }
}
