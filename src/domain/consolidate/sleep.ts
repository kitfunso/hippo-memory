/**
 * Consolidation engine ("Sleep"): decay pass (drop entries below the strength threshold), merge
 * pass (semantic summaries of overlapping episodics), stats.
 */

import { MemoryEntry } from '../../base/memory/entry.js';
import { canAutoDelete } from '../../base/memory/keep-rules.js';
import {
  LEGACY_TYPED_HALF_LIFE,
  type DecayBasis,
  type StrengthModel,
} from '../../base/memory/strength.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { Llm } from '../../base/ports/llm.js';
import { migrateDefaultHalfLife } from './half-life-migration.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { WRITE_BUDGET, type WriteBudget } from '../../base/util/write-budget.js';
import { type DecayOutcome, decayPass, sessionDecayContext } from './decay.js';
import { familyUnits, groupFlush } from './flush-units.js';
import { retireHeldTexts, mergePass } from './merge.js';
import { detectConflicts } from './conflicts.js';
import {
  type ConsolidationResult,
  type ConsolidationStore,
  type SleepRun,
  newConsolidationResult,
} from './run.js';
import { promoteSessionTraces, replayPass, traceWindow } from './traces.js';
import { llmPasses } from './llm-passes.js';
import { DAY_MS } from '../../base/util/time.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import type {
  FlushComponent,
  SleepBegin,
  SleepStart,
  UntracedSession,
} from '../../base/records/consolidation.js';
import { SleepRows, Survivors } from './survivors.js';
import { tombstoneChecks } from './tombstones.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';

export type ConsolidateOptions = {
  dryRun?: boolean;
  now?: Date;
  /** The model the LLM phases call; absent, they are skipped as when no key is set. */
  llm?: Llm;
  /** How long one flush transaction may hold the write lock; a WriteBudget fits, and only its
   * hold is read. */
  budget?: Pick<WriteBudget, 'holdMs'>;
  /** The caller's config for `hippoRoot`; absent, `consolidate` reads the store's config.json. */
  config?: HippoConfig;
  /** The tenant whose completed sessions become traces; absent, `consolidate` uses the default
   * tenant. */
  tenantId?: string;
};

/** The instant a sleep runs at and the strength model it scores by, which its root passes. */
export interface SleepRules {
  readonly now: Date;
  readonly strength: StrengthModel;
}

type RunConsolidationOptions = ConsolidateOptions &
  SleepRules & { config: HippoConfig; tenantId: string; pageRows?: number };

/** A full consolidation pass whose store work goes through `store.consolidation`. */
export async function runConsolidation(
  store: ConsolidationStore,
  options: RunConsolidationOptions,
): Promise<ConsolidationResult> {
  const { now } = options;
  const dryRun = options.dryRun ?? false;
  const { config, tenantId } = options;
  const result = newConsolidationResult(dryRun);
  const traces = traceWindow({ tenantId, now, dryRun, config });
  const { halfLives, start } = await migrateHalfLives(
    store,
    config.defaultHalfLifeDays,
    { dryRun, traces },
    result,
  );
  reportFtsDrift(start.fts, result);

  // One run for every tenant: the run log and the sleep count are host-wide; rows are read a page
  // at a time.
  const preview = dryRun ? halfLives : new Map<string, number>();
  const rows = new SleepRows(store, preview, options.pageRows ?? READ_PAGE_ROWS);
  const run = newSleepRun(store, options, { start, result, rows });
  await runAndFlush(run, options, start.sessions);
  return result;
}

interface SleepRunParts {
  readonly start: SleepStart;
  readonly result: ConsolidationResult;
  readonly rows: SleepRows;
}

function newSleepRun(
  store: ConsolidationStore,
  options: RunConsolidationOptions,
  parts: SleepRunParts,
): SleepRun {
  const { tenantId, now, config } = options;
  const dryRun = options.dryRun ?? false;
  const { start, result, rows } = parts;
  // Retirable: auto-deletable (never pinned, raw or kept for good) and not backing a first-class
  // object.
  const retirable = (entry: MemoryEntry): boolean =>
    canAutoDelete(entry) && !rows.backsObject(entry.id);
  return {
    tenantId,
    store,
    now,
    dryRun,
    config,
    decayOpts: sessionDecayOptions(start, config),
    strength: options.strength,
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
}

async function runAndFlush(
  run: SleepRun,
  options: ConsolidateOptions,
  sessions: readonly UntracedSession[],
): Promise<void> {
  const decay = await decayPass(run);
  await runPassesAfterDecay(run, options.llm, sessions);

  const { holdMs } = options.budget ?? WRITE_BUDGET;
  await commitPending(run, holdMs);
  if (!run.dryRun) await logRun(run, decay);
}

/** A store open that is already current no longer counts the two. */
function reportFtsDrift(fts: SleepStart['fts'], result: ConsolidationResult): void {
  if (fts === null) return;
  result.events.push({ kind: 'ftsResynced', indexedRows: fts.fts, memories: fts.memories });
}

function sessionDecayOptions(start: SleepStart, config: SleepRun['config']): DecayBasis {
  const sessionCtx = sessionDecayContext(start);
  return {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
  };
}

async function runPassesAfterDecay(
  run: SleepRun,
  llm: Llm | undefined,
  sessions: readonly UntracedSession[],
): Promise<void> {
  await promoteSessionTraces(run, sessions);
  await replayPass(run);
  await llmPasses(run, llm);
  await retireHeldTexts(run);
  const mergesSkippedRejected = await mergePass(run);

  if (mergesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${mergesSkippedRejected} merge(s) whose content matches a rejected value`,
    );
  }
}

// A changed default half-life moves memories still on the old base first, so this pass decays them
// at the new one (src/domain/consolidate/half-life-migration.ts).
async function migrateHalfLives(
  store: ConsolidationStore,
  to: number,
  { dryRun, traces }: Pick<SleepBegin, 'dryRun' | 'traces'>,
  result: ConsolidationResult,
): ReturnType<typeof migrateDefaultHalfLife> {
  const halfLife = await migrateDefaultHalfLife(store, to, { dryRun, traces });
  if (halfLife.rescaled > 0) {
    result.events.push({
      kind: 'halfLifeRescaled',
      count: halfLife.rescaled,
      from: halfLife.from,
      to: halfLife.to,
    });
  }
  if (halfLife.typed > 0) {
    result.events.push({
      kind: 'halfLifeTyped',
      count: halfLife.typed,
      from: LEGACY_TYPED_HALF_LIFE,
      to: halfLife.to,
    });
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

// Dormant retention: a dormant memory nobody restored within dormant.retentionDays is deleted for
// good (0 keeps forever); runs even when dormant.enabled is off, so turning it off still ages out
// what earlier sleeps kept.
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
  const committed = await run.store.hippoDb.consolidation.commit({
    flush,
    expireBefore,
    dryRun,
    holdMs,
  });
  if (flush) reportFlush(run, new Set(committed.removedIds));
  if (expireBefore !== null) reportExpiry(run, committed.expired);
}

function reportFlush(run: SleepRun, left: ReadonlySet<string>): void {
  const { result, pendingDeletes, pendingDormant } = run;
  for (const id of [...pendingDeletes, ...pendingDormant.map((m) => m.entry.id)]) {
    if (!left.has(id)) result.events.push({ kind: 'notRemoved', id });
  }
  result.removedIds = pendingDeletes.filter((id) => left.has(id));
  result.removed = result.removedIds.length;
  result.dormant = pendingDormant.filter((m) => left.has(m.entry.id)).length;
}

function reportExpiry(run: SleepRun, expired: number): void {
  const { config, result } = run;
  result.dormantExpired = expired;
  if (result.dormantExpired > 0) {
    result.events.push({
      kind: 'dormantExpired',
      count: result.dormantExpired,
      retentionDays: config.dormant.retentionDays,
    });
  }
}

async function logRun(run: SleepRun, decay: DecayOutcome): Promise<void> {
  const { now, result, survivors } = run;
  const detectedConflicts = await detectConflicts(survivors.rows(), now, {
    strength: run.strength,
    decayOpts: run.decayOpts,
    rescuedIds: decay.rescuedIds,
    pagesOf: (ids) => survivors.pagesOf(ids),
  });

  if (detectedConflicts.length > 0) {
    result.events.push({ kind: 'conflictsDetected', count: detectedConflicts.length });
  }

  await run.store.hippoDb.consolidation.recordSleep({
    conflicts: detectedConflicts,
    at: now.toISOString(),
    decayed: result.decayed,
    merged: result.merged,
    removed: result.removed,
  });
  if (decay.rescuedEntries.length > 0) await auditRescues(run, decay);
}

// One audit row per rescue, written only after the last flush chunk commits, so a run stopped
// mid-flush asserts no rescue.
async function auditRescues(
  run: SleepRun,
  { rescuedEntries, rankById }: DecayOutcome,
): Promise<void> {
  const { result } = run;
  const rescueEvent = (entry: Pick<MemoryEntry, 'id' | 'tenantId'>): AppendAuditOptions => {
    const rank = rankById.get(entry.id);
    return {
      tenantId: entry.tenantId,
      actor: 'sleep',
      op: 'mv_rescue',
      targetId: entry.id,
      metadata: rank
        ? {
            rank: rank.rank,
            totalNonPinned: rank.totalNonPinned,
            keepN: rank.keepN,
            score: rank.score,
          }
        : {},
    };
  };
  try {
    // Row by row: one failed audit write must not silently drop every remaining row.
    const auditFailures = await run.store.hippoDb.consolidation.auditEachRow(
      rescuedEntries.map(rescueEvent),
    );
    if (auditFailures > 0) {
      result.events.push({ kind: 'rescueAuditFailed', failures: auditFailures });
    }
  } catch (err) {
    // An audit store that will not open must never crash the mutation it records.
    log.warn(`mv_rescue audit unavailable: ${errorMessage(err)}`, errorFields(err));
    result.events.push({ kind: 'rescueAuditUnavailable', rescues: rescuedEntries.length });
  }
}
