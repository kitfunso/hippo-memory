/**
 * Moves a store's memories to a new default half-life: only memories still on the old base are rescaled
 * (`deriveHalfLife(from, entry)` plus recall bonus).
 * Memories hippo shortened since, or with their own fixed half-life, keep theirs; rescales are audit-logged and `meta`
 * records the base, so it runs once.
 */
import { deriveHalfLife, LEGACY_TYPED_HALF_LIFE, type MemoryEntry } from '../core/memory.js';
import type { HalfLifeChange, HalfLifeRows } from '../store/port/consolidation.js';
import type { Consolidation } from '../store/port.js';

const TYPED_SOURCES: ReadonlySet<string> = new Set([
  'decision',
  'incident',
  'process',
  'policy',
  'skill',
  'project_brief',
  'customer_note',
]);

/** What {@link migrateDefaultHalfLife} did, or would do under `dryRun`. */
export interface HalfLifeMigrationResult {
  from: number;
  to: number;
  /** Memories moved to the new base. */
  rescaled: number;
  /** Memories of decisions, incidents and other objects moved off the flat 90 days. */
  typed: number;
  /** Memories left alone because they are not on the old base. */
  kept: number;
  dryRun: boolean;
  /** New half-life per moved id, so a dry run can preview decay at the new base. */
  halfLives: ReadonlyMap<string, number>;
}

type HalfLifeFields = Pick<MemoryEntry, 'half_life_days' | 'tags' | 'schema_fit' | 'retrieval_count' | 'superseded_by'>;

/** Recall bonus over `written`, the half-life `entry` got at write, or null when off it; each recall added 2 days. */
export function halfLifeRecallBonus(entry: HalfLifeFields, written: number): number | null {
  if (entry.superseded_by || entry.tags.includes('invalidated') || entry.tags.includes('superseded')) return null;
  const bonus = entry.half_life_days - written;
  const k = Math.round(bonus / 2);
  return Math.abs(bonus - 2 * k) < 1e-9 && k >= 0 && k <= entry.retrieval_count ? bonus : null;
}

type MoveFields = HalfLifeFields & Pick<MemoryEntry, 'source'>;

/** The half-life `e` moves to from base `from`, or null when it is not on that base. */
function baseTarget(e: MoveFields, from: number, to: number): number | null {
  if (from === to) return null;
  const bonus = halfLifeRecallBonus(e, deriveHalfLife(from, e));
  return bonus === null ? null : deriveHalfLife(to, e) + bonus;
}

/** True for an object's memory still on the flat 90 days. */
function onTypedBase(e: MoveFields): boolean {
  return TYPED_SOURCES.has(e.source) && halfLifeRecallBonus(e, LEGACY_TYPED_HALF_LIFE) !== null;
}

/** The half-life an object's memory moves to off the flat 90 days, or null when it stays. */
function typedTarget(e: MoveFields, to: number): number | null {
  const bonus = TYPED_SOURCES.has(e.source) ? halfLifeRecallBonus(e, LEGACY_TYPED_HALF_LIFE) : null;
  const next = bonus === null ? e.half_life_days : deriveHalfLife(to, e) + bonus;
  return next === e.half_life_days ? null : next;
}

/**
 * Move the store's memories, and those of objects on the old flat 90 days, from their recorded base to `to`, once;
 * `dryRun` writes nothing.
 */
export function migrateDefaultHalfLife(
  store: Consolidation,
  to: number,
  opts: { dryRun?: boolean; actor?: string } = {},
): HalfLifeMigrationResult {
  const dryRun = opts.dryRun ?? false;
  const { from, outcome } = store.moveHalfLives(to, { dryRun, actor: opts.actor ?? 'system' }, (rows) => {
    const { basePlan, typedPlan, count } = planMoves(rows, to);
    const plan = [...basePlan, ...typedPlan];
    return {
      moves: [
        { from: rows.from, to, entries: basePlan },
        { from: LEGACY_TYPED_HALF_LIFE, to, entries: typedPlan },
      ],
      outcome: {
        rescaled: basePlan.length,
        typed: typedPlan.length,
        kept: count - plan.length,
        halfLives: new Map(plan.map((e) => [e.id, e.halfLifeDays])),
      },
    };
  });
  const moved = outcome ?? { rescaled: 0, typed: 0, kept: 0, halfLives: new Map<string, number>() };
  return {
    from,
    to,
    rescaled: moved.rescaled,
    typed: moved.typed,
    kept: moved.kept,
    dryRun,
    halfLives: moved.halfLives,
  };
}

/** A row either move may change, kept in place of the row while the cursor runs. */
interface Movable {
  change: Omit<HalfLifeChange, 'halfLifeDays'>;
  /** On the flat 90 days an object's writer gave, by source and recall bonus alone. */
  typedBase: boolean;
  base: number | null;
  typed: number | null;
}

/** The base move and the move of object memories, planned from one pass over the rows. */
function planMoves(rows: HalfLifeRows, to: number) {
  const { typedPending } = rows;
  const objects = objectMemoryIds(rows.objectRows);
  const losers = conflictLosers(rows.conflictAudits, rows.resolvedConflicts);
  // A supersede copy can come before its source, so routing waits for the pass to finish.
  const copies = new Set<string>();
  const movable: Movable[] = [];
  let count = 0;
  for (const e of rows.rows) {
    count++;
    if (e.superseded_by) copies.add(e.superseded_by);
    const base = baseTarget(e, rows.from, to);
    const typed = typedPending ? typedTarget(e, to) : null;
    if (base === null && typed === null) continue;
    const change = { id: e.id, tenantId: e.tenant_id, oldHalfLifeDays: e.half_life_days };
    movable.push({ change, typedBase: onTypedBase(e), base, typed });
  }
  // Provenance before shape: an object's memory came from its writer, a supersede copy from the base (it keeps the
  // source). Shape decides the rest.
  const objectWritten = (m: Movable) => objects.all.has(m.change.id) || (!copies.has(m.change.id) && m.typedBase);
  const basePlan: HalfLifeChange[] = [];
  const typedPlan: HalfLifeChange[] = [];
  for (const m of movable) {
    const { id } = m.change;
    if (typedPending && objectWritten(m)) {
      const exempt = objects.retired.has(id) || losers.has(id);
      if (m.typed !== null && !exempt) typedPlan.push({ ...m.change, halfLifeDays: m.typed });
    } else if (m.base !== null) {
      basePlan.push({ ...m.change, halfLifeDays: m.base });
    }
  }
  return { basePlan, typedPlan, count };
}

/**
 * Memories behind every object, and those behind a superseded or closed one. Retiring an object leaves its memory
 * untouched, so only its table knows.
 */
function objectMemoryIds(objectRows: HalfLifeRows['objectRows']) {
  const all = new Set<string>();
  const retired = new Set<string>();
  for (const r of objectRows) {
    all.add(r.memory_id);
    if (r.status === 'superseded' || r.status === 'closed') retired.add(r.memory_id);
  }
  return { all, retired };
}

/** Memories that lost a conflict, which resolveConflict halved untagged. A resolved conflict with no audit
 * row (resolved before resolves were audited, or found stale) names no winner, so both sides count. */
function conflictLosers(
  audited: HalfLifeRows['conflictAudits'],
  resolved: HalfLifeRows['resolvedConflicts'],
): Set<string> {
  const losers = new Set(audited.map((a) => a.loserId));
  const named = new Set(audited.map((a) => a.conflictId));
  for (const c of resolved) if (!named.has(c.id)) losers.add(c.memory_a_id).add(c.memory_b_id);
  return losers;
}
