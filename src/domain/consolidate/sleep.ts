/**
 * Consolidation engine ("Sleep"): decay pass (drop entries below the strength threshold), merge pass (semantic
 * summaries of overlapping episodics), stats.
 */

import { evalNow, strengthAblation } from '../../base/memory/ablation.js';
import { MemoryEntry, canAutoDelete, LEGACY_TYPED_HALF_LIFE, type DecayOptions } from '../../base/memory/memory.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { Llm } from '../../base/ports/llm.js';
import { migrateDefaultHalfLife } from './half-life-migration.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { WRITE_BUDGET, type WriteBudget } from '../../base/util/write-budget.js';
import { type DecayOutcome, decayPass } from './decay.js';
import { familyUnits, groupFlush } from './flush-units.js';
import { retireHeldTexts, mergePass } from './merge.js';
import { detectConflicts } from './conflicts.js';
import {
  type ConsolidationResult,
  type ConsolidationStore,
  type SleepRun,
  newConsolidationResult,
  syncFtsIndex,
} from './run.js';
import { promoteSessionTraces, replayPass } from './traces.js';
import { llmPasses } from './llm-passes.js';
import { physicsPass } from './physics-pass.js';
import { DAY_MS } from '../../base/util/time.js';
import { plural } from '../../base/util/format.js';
import type { AppendAuditOpts } from '../../store/port/types.js';
import { SleepRows, Survivors } from './survivors.js';
import { tombstoneChecks } from './tombstones.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';

export type ConsolidateOptions = {
  dryRun?: boolean;
  now?: Date;
  /** The model the LLM phases call; absent, they are skipped as when no key is set. */
  llm?: Llm;
  /** How long one flush transaction may hold the write lock; a WriteBudget fits, and only its hold is read. */
  budget?: Pick<WriteBudget, 'holdMs'>;
  /** The caller's config for `hippoRoot`; absent, `consolidate` reads the store's config.json. */
  config?: HippoConfig;
  /** The tenant whose completed sessions become traces; absent, `consolidate` uses the default tenant. */
  tenantId?: string;
};

/** A full consolidation pass whose store work goes through `store.consolidation`. */
export async function runConsolidation(
  store: ConsolidationStore,
  options: ConsolidateOptions & { config: HippoConfig; tenantId: string; pageRows?: number },
): Promise<ConsolidationResult> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const dryRun = options.dryRun ?? false;
  const result = newConsolidationResult(dryRun);
  const halfLife = await migrateHalfLives(store, options.config.defaultHalfLifeDays, dryRun, result);
  await syncFtsIndex(store, dryRun, result);

  // One run for every tenant: physics, the run log and the sleep count are host-wide; rows are read a page at a time.
  const preview = dryRun ? halfLife.halfLives : new Map<string, number>();
  const rows = new SleepRows(store, preview, options.pageRows ?? READ_PAGE_ROWS);
  // Retirable: auto-deletable (never pinned, raw or kept for good) and not backing a first-class object.
  const retirable = (entry: MemoryEntry): boolean => canAutoDelete(entry) && !rows.backsObject(entry.id);

  const { config } = options;
  const decayOpts = await sessionDecayOptions(store, config);

  const run: SleepRun = {
    tenantId: options.tenantId,
    store,
    now,
    dryRun,
    config,
    decayOpts,
    result,
    rows,
    retirable,
    tombstones: tombstoneChecks(store, dryRun),
    survivors: new Survivors(rows),
    // Collect all writes/deletes and batch them at the end
    pendingRefreshes: [],
    pendingWrites: [],
    pendingDeletes: [],
    pendingDormant: [],
    parentOf: new Map(),
    units: [],
  };

  await runAndFlush(run, options);
  return result;
}

async function runAndFlush(run: SleepRun, options: ConsolidateOptions): Promise<void> {
  const decay = await decayPass(run);
  await runPassesAfterDecay(run, options.llm);

  const { holdMs } = options.budget ?? WRITE_BUDGET;
  await flushPending(run, holdMs);
  await expireDormant(run, holdMs);
  if (!run.dryRun) await logRun(run, decay);
}

async function sessionDecayOptions(store: ConsolidationStore, config: SleepRun['config']): Promise<DecayOptions> {
  const sessionCtx = await store.consolidation.sessionDecayContext();
  return {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
    ablation: strengthAblation(),
    lossAversionRatio: config.runtime?.lossAversionRatio,
  };
}

async function runPassesAfterDecay(run: SleepRun, llm: Llm | undefined): Promise<void> {
  await promoteSessionTraces(run);
  await replayPass(run);
  await llmPasses(run, llm);
  await physicsPass(run);
  await retireHeldTexts(run);
  const mergesSkippedRejected = await mergePass(run);

  if (mergesSkippedRejected > 0) {
    log.warn(`consolidate: skipped ${mergesSkippedRejected} merge(s) whose content matches a rejected value`);
  }
}

// A changed default half-life moves memories still on the old base first, so this pass decays them at the new one
// (src/domain/consolidate/half-life-migration.ts).
async function migrateHalfLives(
  store: ConsolidationStore,
  to: number,
  dryRun: boolean,
  result: ConsolidationResult,
): ReturnType<typeof migrateDefaultHalfLife> {
  const halfLife = await migrateDefaultHalfLife(store, to, { dryRun });
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

async function flushPending(run: SleepRun, holdMs: number): Promise<void> {
  const { result, pendingDeletes, pendingDormant } = run;
  result.removedIds = pendingDeletes;
  if (run.dryRun) return;
  const ops = {
    refreshes: run.pendingRefreshes,
    writes: run.pendingWrites,
    deletes: pendingDeletes,
    dormant: pendingDormant,
  };
  const units = [...run.units, ...familyUnits(ops, (id) => run.parentOf.get(id))];
  const components = groupFlush(ops, units);
  // The snapshot keeps what the DAG passes and other writers changed while sleep ran.
  const left = new Set(
    await run.store.consolidation.commitFlush(components, { snapshot: run.survivors.bases, holdMs }),
  );
  for (const id of [...pendingDeletes, ...pendingDormant.map((m) => m.entry.id)]) {
    if (!left.has(id)) result.details.push(`  ↩  ${id} not removed: pinned or already gone before sleep saved`);
  }
  result.removedIds = pendingDeletes.filter((id) => left.has(id));
  result.removed = result.removedIds.length;
  result.dormant = pendingDormant.filter((m) => left.has(m.entry.id)).length;
}

// Dormant retention: a dormant memory nobody restored within dormant.retentionDays is deleted for good (0 keeps
// forever); runs even when dormant.enabled is off, so turning it off still ages out what earlier sleeps kept.
async function expireDormant(run: SleepRun, holdMs: number): Promise<void> {
  const { config, result, dryRun } = run;
  if (!(config.dormant.retentionDays > 0)) return;
  const cutoff = new Date(run.now.getTime() - config.dormant.retentionDays * DAY_MS).toISOString();
  result.dormantExpired = await run.store.consolidation.expireDormant(cutoff, { dryRun, holdMs });
  if (result.dormantExpired > 0) {
    result.details.push(
      `  ⌛ ${dryRun ? 'would expire' : 'expired'} ${result.dormantExpired} dormant ` +
        `memor${result.dormantExpired === 1 ? 'y' : 'ies'} ` +
        `older than ${config.dormant.retentionDays} days`,
    );
  }
}

async function logRun(run: SleepRun, decay: DecayOutcome): Promise<void> {
  const { now, result, survivors } = run;
  const { consolidation } = run.store;
  const detectedConflicts = await detectConflicts(survivors.rows(), now, {
    decayOpts: run.decayOpts,
    rescuedIds: decay.rescuedIds,
    pagesOf: (ids) => survivors.pagesOf(ids),
  });
  await consolidation.replaceConflicts(detectedConflicts, now.toISOString());

  if (detectedConflicts.length > 0) {
    result.details.push(`  ⚠️ detected ${plural(detectedConflicts.length, 'memory conflict')}`);
  }

  await consolidation.recordRun({
    timestamp: now.toISOString(),
    decayed: result.decayed,
    merged: result.merged,
    removed: result.removed,
  });
  await consolidation.countSleep();
  if (decay.rescuedEntries.length > 0) await auditRescues(run, decay);
}

// One audit row per rescue, written only after the last flush chunk commits, so a run stopped mid-flush asserts no
// rescue.
async function auditRescues(run: SleepRun, { rescuedEntries, rankById }: DecayOutcome): Promise<void> {
  const { result } = run;
  const rescueEvent = (entry: Pick<MemoryEntry, 'id' | 'tenantId'>): AppendAuditOpts => {
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
    const auditFailures = await run.store.consolidation.auditEachRow(rescuedEntries.map(rescueEvent));
    if (auditFailures > 0) {
      result.details.push(
        `  ⚠️ memory-value: ${plural(auditFailures, 'mv_rescue audit row')} ` +
          `failed to write (the rescue itself still landed)`,
      );
    }
  } catch (err) {
    // An audit store that will not open must never crash the mutation it records.
    log.warn(`mv_rescue audit unavailable: ${errorMessage(err)}`, errorFields(err));
    result.details.push(
      `  ⚠️ memory-value: mv_rescue audit unavailable this cycle ` +
        `(${plural(rescuedEntries.length, 'rescue')} not audited)`,
    );
  }
}
