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
import { type DecayOutcome, decayPass, sessionDecayContext } from './decay.js';
import { familyUnits, groupFlush } from './flush-units.js';
import { retireHeldTexts, mergePass } from './merge.js';
import { detectConflicts } from './conflicts.js';
import { type ConsolidationResult, type ConsolidationStore, type SleepRun, newConsolidationResult } from './run.js';
import { promoteSessionTraces, replayPass, traceWindow } from './traces.js';
import { llmPasses } from './llm-passes.js';
import { physicsPass } from './physics-pass.js';
import { DAY_MS } from '../../base/util/time.js';
import { plural } from '../../base/util/format.js';
import type { AppendAuditOpts } from '../../store/port/types.js';
import type { FlushComponent, SleepBegin, SleepStart } from '../../store/port/consolidation.js';
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
  const { config, tenantId } = options;
  const result = newConsolidationResult(dryRun);
  const traces = traceWindow({ tenantId, now, dryRun, config });
  const { halfLives, start } = await migrateHalfLives(store, config.defaultHalfLifeDays, { dryRun, traces }, result);
  reportFtsDrift(start.fts, dryRun, result);

  // One run for every tenant: physics, the run log and the sleep count are host-wide; rows are read a page at a time.
  const preview = dryRun ? halfLives : new Map<string, number>();
  const rows = new SleepRows(store, preview, options.pageRows ?? READ_PAGE_ROWS);
  // Retirable: auto-deletable (never pinned, raw or kept for good) and not backing a first-class object.
  const retirable = (entry: MemoryEntry): boolean => canAutoDelete(entry) && !rows.backsObject(entry.id);

  const run: SleepRun = {
    tenantId,
    store,
    now,
    dryRun,
    config,
    decayOpts: sessionDecayOptions(start, config),
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

  await runAndFlush(run, options, start.sessions);
  return result;
}

async function runAndFlush(run: SleepRun, options: ConsolidateOptions, sessions: readonly string[]): Promise<void> {
  const decay = await decayPass(run);
  await runPassesAfterDecay(run, options.llm, sessions);

  const { holdMs } = options.budget ?? WRITE_BUDGET;
  await commitPending(run, holdMs);
  if (!run.dryRun) await logRun(run, decay);
}

/** A store open that is already current no longer counts the two. */
function reportFtsDrift(fts: SleepStart['fts'], dryRun: boolean, result: ConsolidationResult): void {
  if (fts === null) return;
  result.details.push(
    `  🔎 ${dryRun ? 'would re-sync' : 're-synced'} the full-text index (${fts.fts} indexed rows for ` +
      `${fts.memories} memories)`,
  );
}

function sessionDecayOptions(start: SleepStart, config: SleepRun['config']): DecayOptions {
  const sessionCtx = sessionDecayContext(start);
  return {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
    ablation: strengthAblation(),
    lossAversionRatio: config.runtime?.lossAversionRatio,
  };
}

async function runPassesAfterDecay(run: SleepRun, llm: Llm | undefined, sessions: readonly string[]): Promise<void> {
  await promoteSessionTraces(run, sessions);
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
  { dryRun, traces }: Pick<SleepBegin, 'dryRun' | 'traces'>,
  result: ConsolidationResult,
): ReturnType<typeof migrateDefaultHalfLife> {
  const halfLife = await migrateDefaultHalfLife(store, to, { dryRun, traces });
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

/** The pending ops as the flush commits them, each unit whole in one transaction. */
function flushComponents(run: SleepRun): FlushComponent[] {
  const ops = {
    refreshes: run.pendingRefreshes,
    writes: run.pendingWrites,
    deletes: run.pendingDeletes,
    dormant: run.pendingDormant,
  };
  const units = [...run.units, ...familyUnits(ops, (id) => run.parentOf.get(id))];
  return groupFlush(ops, units);
}

// Dormant retention: a dormant memory nobody restored within dormant.retentionDays is deleted for good (0 keeps
// forever); runs even when dormant.enabled is off, so turning it off still ages out what earlier sleeps kept.
function dormantCutoff({ config, now }: SleepRun): string | null {
  if (!(config.dormant.retentionDays > 0)) return null;
  return new Date(now.getTime() - config.dormant.retentionDays * DAY_MS).toISOString();
}

/** The flush (none under dryRun), then the dormant expiry, in one store call. */
async function commitPending(run: SleepRun, holdMs: number): Promise<void> {
  const { result, dryRun } = run;
  result.removedIds = run.pendingDeletes;
  // The snapshot keeps what the DAG passes and other writers changed while sleep ran.
  const flush = dryRun ? null : { components: flushComponents(run), snapshot: run.survivors.bases };
  const expireBefore = dormantCutoff(run);
  const committed = await run.store.consolidation.commit({ flush, expireBefore, dryRun, holdMs });
  if (flush) reportFlush(run, new Set(committed.removedIds));
  if (expireBefore !== null) reportExpiry(run, committed.expired);
}

function reportFlush(run: SleepRun, left: ReadonlySet<string>): void {
  const { result, pendingDeletes, pendingDormant } = run;
  for (const id of [...pendingDeletes, ...pendingDormant.map((m) => m.entry.id)]) {
    if (!left.has(id)) result.details.push(`  ↩  ${id} not removed: pinned or already gone before sleep saved`);
  }
  result.removedIds = pendingDeletes.filter((id) => left.has(id));
  result.removed = result.removedIds.length;
  result.dormant = pendingDormant.filter((m) => left.has(m.entry.id)).length;
}

function reportExpiry(run: SleepRun, expired: number): void {
  const { config, result, dryRun } = run;
  result.dormantExpired = expired;
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
  const detectedConflicts = await detectConflicts(survivors.rows(), now, {
    decayOpts: run.decayOpts,
    rescuedIds: decay.rescuedIds,
    pagesOf: (ids) => survivors.pagesOf(ids),
  });

  if (detectedConflicts.length > 0) {
    result.details.push(`  ⚠️ detected ${plural(detectedConflicts.length, 'memory conflict')}`);
  }

  await run.store.consolidation.recordSleep({
    conflicts: detectedConflicts,
    at: now.toISOString(),
    decayed: result.decayed,
    merged: result.merged,
    removed: result.removed,
  });
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
