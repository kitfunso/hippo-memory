/**
 * Moving a store's memories to a new default half-life.
 *
 * Each memory stores its own `half_life_days`, set at write from the
 * default base and a few write-time multipliers (`deriveHalfLife`). Changing
 * the default therefore reaches only new memories; without this migration a
 * store would mix old-base and new-base memories, a state the decay
 * evaluation never tested. The rule, declared before any run:
 *
 * - only a memory still on the old base is rescaled: its half-life is
 *   `deriveHalfLife(from, entry)` plus its recall bonus. A memory hippo shortened since
 *   (invalidated, superseded, a merge source, marked bad) or one with its own
 *   fixed half-life (decisions, incidents, customer notes) keeps its value;
 * - every rescale is written to the audit log with the ids, so it can be
 *   undone, and the store records the base it is on (`meta`), so the
 *   migration runs once.
 *
 * `hippo sleep` runs it before its decay pass, from the base the store is on
 * (7 days when never recorded) to the configured `defaultHalfLifeDays`. Once per store it also
 * moves memories of live decisions, incidents and other objects off the flat 90 days they used to get.
 */
import { deriveHalfLife, type MemoryEntry } from '../core/memory.js';
import { HALF_LIFE_BASE_META_KEY, LEGACY_TYPED_HALF_LIFE } from '../store/open.js';
import { moveHalfLives, recordedHalfLifeBase, type HalfLifeRows } from '../store/half-life.js';

const TYPED_SOURCES: ReadonlySet<string> = new Set(['decision', 'incident', 'process', 'policy', 'skill', 'project_brief', 'customer_note']);

export { HALF_LIFE_BASE_META_KEY, LEGACY_TYPED_HALF_LIFE };

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

/** The entries to rescale from `from` to `to`, as copies that keep their recall bonus. Pure. */
export function planHalfLifeMigration(entries: readonly MemoryEntry[], from: number, to: number): MemoryEntry[] {
  if (from === to) return [];
  return entries.flatMap((e) => {
    const bonus = halfLifeRecallBonus(e, deriveHalfLife(from, e));
    return bonus === null ? [] : [{ ...e, half_life_days: deriveHalfLife(to, e) + bonus }];
  });
}

/** Memories of decisions, incidents and other objects still on the flat 90 days, as copies on `to` that keep their recall bonus. Pure. */
export function planTypedHalfLifeMigration(entries: readonly MemoryEntry[], to: number): MemoryEntry[] {
  return entries.flatMap((e) => {
    const bonus = TYPED_SOURCES.has(e.source) ? halfLifeRecallBonus(e, LEGACY_TYPED_HALF_LIFE) : null;
    const next = bonus === null ? e.half_life_days : deriveHalfLife(to, e) + bonus;
    return next === e.half_life_days ? [] : [{ ...e, half_life_days: next }];
  });
}

/** The base this store's memories are on. */
export function storeHalfLifeBase(hippoRoot: string): number {
  return recordedHalfLifeBase(hippoRoot);
}

/**
 * Move the store's memories from the base they are on, and those of objects from
 * the old flat 90 days, to `to`, once. Under `dryRun` nothing is written, the recorded
 * base included.
 */
export function migrateDefaultHalfLife(hippoRoot: string, to: number, opts: { dryRun?: boolean; actor?: string } = {}): HalfLifeMigrationResult {
  const dryRun = opts.dryRun ?? false;
  const { from, outcome } = moveHalfLives(hippoRoot, to, { dryRun, actor: opts.actor ?? 'system' }, (rows) => {
    const { basePlan, typedPlan } = planMoves(rows, to);
    const plan = [...basePlan, ...typedPlan];
    return {
      moves: [{ from: rows.from, to, entries: basePlan }, { from: LEGACY_TYPED_HALF_LIFE, to, entries: typedPlan }],
      outcome: { rescaled: basePlan.length, typed: typedPlan.length, kept: rows.all.length - plan.length, halfLives: new Map(plan.map((e) => [e.id, e.half_life_days])) },
    };
  });
  const moved = outcome ?? { rescaled: 0, typed: 0, kept: 0, halfLives: new Map<string, number>() };
  return { from, to, rescaled: moved.rescaled, typed: moved.typed, kept: moved.kept, dryRun, halfLives: moved.halfLives };
}

/** The base move and the move of object memories, planned from one read of the store. Pure. */
function planMoves(rows: HalfLifeRows, to: number) {
  const { all, typedPending } = rows;
  const objects = objectMemoryIds(rows.objectRows);
  const losers = conflictLosers(rows.conflictAudits, rows.resolvedConflicts);
  const copies = new Set(all.flatMap((e) => (e.superseded_by ? [e.superseded_by] : [])));
  // Provenance before shape: an object's memory came from its writer, a supersede copy from the base (it keeps the source). Shape decides the rest.
  const objectWritten = (e: MemoryEntry) =>
    objects.all.has(e.id) || (!copies.has(e.id) && TYPED_SOURCES.has(e.source) && halfLifeRecallBonus(e, LEGACY_TYPED_HALF_LIFE) !== null);
  const typedPlan = typedPending ? planTypedHalfLifeMigration(all.filter((e) => objectWritten(e) && !objects.retired.has(e.id) && !losers.has(e.id)), to) : [];
  const basePlan = planHalfLifeMigration(typedPending ? all.filter((e) => !objectWritten(e)) : all, rows.from, to);
  return { basePlan, typedPlan };
}

/** Memories behind every object, and those behind a superseded or closed one. Retiring an object leaves its memory untouched, so only its table knows. */
function objectMemoryIds(objectRows: HalfLifeRows['objectRows']) {
  const all = new Set<string>();
  const retired = new Set<string>();
  for (const r of objectRows) {
    all.add(r.memory_id);
    if (r.status === 'superseded' || r.status === 'closed') retired.add(r.memory_id);
  }
  return { all, retired };
}

/** Memories that lost a conflict, which resolveConflict halved untagged. A resolved conflict with no audit row (resolved before resolves were audited, or found stale) names no winner, so both sides count. */
function conflictLosers(audited: HalfLifeRows['conflictAudits'], resolved: HalfLifeRows['resolvedConflicts']): Set<string> {
  const losers = new Set(audited.map((a) => a.loserId));
  const named = new Set(audited.map((a) => a.conflictId));
  for (const c of resolved) if (!named.has(c.id)) losers.add(c.memory_a_id).add(c.memory_b_id);
  return losers;
}
