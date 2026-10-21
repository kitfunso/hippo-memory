// The plan of a default half-life move: which memories still sit on an old base and where each one goes. Pure, so the
// store runs it inside the move's own write scope and plan, write and audit stay one transaction.
import { deriveHalfLife, LEGACY_TYPED_HALF_LIFE, type MemoryEntry } from './memory.js';

const TYPED_SOURCES: ReadonlySet<string> = new Set([
  'decision',
  'incident',
  'process',
  'policy',
  'skill',
  'project_brief',
  'customer_note',
]);

/** 'retired' when the memory backs a superseded or closed typed object, 'live' when it backs only others, null when it
 * backs none. */
export type ObjectLink = 'retired' | 'live' | null;

/** A row a move is planned from; `object` is read only while the typed move is pending, else null. */
export interface HalfLifeRow {
  entry: MemoryEntry;
  object: ObjectLink;
}

/** What a move is planned from. The object and conflict rows are read only while the typed move is pending. */
export interface HalfLifeRows {
  /** The base the store's memories are on. */
  from: number;
  /** True until the store has moved its object memories off their old flat half-life. */
  typedPending: boolean;
  /** Every row once, by created then id, through one cursor: the plan keeps only what a move needs. */
  rows: Iterable<HalfLifeRow>;
  conflictAudits: Array<{ conflictId: number; loserId: string }>;
  resolvedConflicts: Array<{ id: number; memory_a_id: string; memory_b_id: string }>;
}

/** One memory's half-life before and after a move. */
export interface HalfLifeChange {
  id: string;
  tenantId: string;
  halfLifeDays: number;
  oldHalfLifeDays: number;
}

/** The changes of one move, and the bases their audit rows name. */
export interface HalfLifeMove {
  from: number;
  to: number;
  entries: readonly HalfLifeChange[];
}

/** What a move did, or would do under a dry run. */
export interface HalfLifeOutcome {
  /** Memories moved to the new base. */
  rescaled: number;
  /** Memories of decisions, incidents and other objects moved off the flat 90 days. */
  typed: number;
  /** Memories left alone because they are not on the old base. */
  kept: number;
  /** New half-life per moved id, so a dry run can preview decay at the new base. */
  halfLives: ReadonlyMap<string, number>;
}

type HalfLifeFields = Pick<MemoryEntry, 'halfLifeDays' | 'tags' | 'schemaFit' | 'retrievalCount' | 'supersededBy'>;

/** Recall bonus over `written`, the half-life `entry` got at write, or null when off it; each recall added 2 days. */
export function halfLifeRecallBonus(entry: HalfLifeFields, written: number): number | null {
  if (entry.supersededBy || entry.tags.includes('invalidated') || entry.tags.includes('superseded')) return null;
  const bonus = entry.halfLifeDays - written;
  const k = Math.round(bonus / 2);
  return Math.abs(bonus - 2 * k) < 1e-9 && k >= 0 && k <= entry.retrievalCount ? bonus : null;
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
  const next = bonus === null ? e.halfLifeDays : deriveHalfLife(to, e) + bonus;
  return next === e.halfLifeDays ? null : next;
}

/** The writes a move makes and what they come to. */
export interface HalfLifePlan {
  readonly moves: readonly HalfLifeMove[];
  readonly outcome: HalfLifeOutcome;
}

/** The base move and the typed move to base `to`, planned from one pass over the rows, with what they come to. */
export function planHalfLifeMoves(rows: HalfLifeRows, to: number): HalfLifePlan {
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
}

/** A row either move may change, kept in place of the row while the cursor runs. */
interface Movable {
  change: Omit<HalfLifeChange, 'halfLifeDays'>;
  /** On the flat 90 days an object's writer gave, by source and recall bonus alone. */
  typedBase: boolean;
  base: number | null;
  typed: number | null;
  object: ObjectLink;
}

function planMoves(rows: HalfLifeRows, to: number) {
  const { typedPending } = rows;
  const losers = conflictLosers(rows.conflictAudits, rows.resolvedConflicts);
  // A supersede copy can come before its source, so routing waits for the pass to finish.
  const copies = new Set<string>();
  const movable: Movable[] = [];
  let count = 0;
  for (const { entry: e, object } of rows.rows) {
    count++;
    if (e.supersededBy) copies.add(e.supersededBy);
    const base = baseTarget(e, rows.from, to);
    const typed = typedPending ? typedTarget(e, to) : null;
    if (base === null && typed === null) continue;
    const change = { id: e.id, tenantId: e.tenantId, oldHalfLifeDays: e.halfLifeDays };
    movable.push({ change, typedBase: onTypedBase(e), base, typed, object });
  }
  // Provenance before shape: an object's memory came from its writer, a supersede copy from the base (it keeps the
  // source). Shape decides the rest.
  const objectWritten = (m: Movable) => m.object !== null || (!copies.has(m.change.id) && m.typedBase);
  const basePlan: HalfLifeChange[] = [];
  const typedPlan: HalfLifeChange[] = [];
  for (const m of movable) {
    const { id } = m.change;
    if (typedPending && objectWritten(m)) {
      // Retiring an object leaves its memory untouched, so only its table knows.
      const exempt = m.object === 'retired' || losers.has(id);
      if (m.typed !== null && !exempt) typedPlan.push({ ...m.change, halfLifeDays: m.typed });
    } else if (m.base !== null) {
      basePlan.push({ ...m.change, halfLifeDays: m.base });
    }
  }
  return { basePlan, typedPlan, count };
}

/** Memories that lost a conflict, which resolveConflict halved untagged. A resolved conflict with no audit row
 * (resolved before resolves were audited, or found stale) names no winner, so both sides count. */
function conflictLosers(
  audited: HalfLifeRows['conflictAudits'],
  resolved: HalfLifeRows['resolvedConflicts'],
): Set<string> {
  const losers = new Set(audited.map((a) => a.loserId));
  const named = new Set(audited.map((a) => a.conflictId));
  for (const c of resolved) if (!named.has(c.id)) losers.add(c.memory_a_id).add(c.memory_b_id);
  return losers;
}
