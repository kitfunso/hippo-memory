/**
 * Moving a store's memories to a new default half-life.
 *
 * Each memory stores its own `half_life_days`, set at write from the
 * default base and a few write-time multipliers (`deriveHalfLife`). Changing
 * the default therefore reaches only new memories; without this migration a
 * store would mix old-base and new-base memories, a state the decay
 * evaluation never tested (docs/evals/2026-09-24-decay-default-prereg.md,
 * Migration). The rule, declared there before any run:
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
import { deriveHalfLife, type MemoryEntry } from './memory.js';
import { openStore, selectAllEntries, HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY } from './store.js';
import { openHippoDb, closeHippoDb, getMeta, setMeta, type DatabaseSyncLike } from './db.js';
import { appendAuditEvent } from './audit.js';

/** The base every store used before the base was recorded. */
export const LEGACY_HALF_LIFE_BASE = 7;

/** The flat half-life the decision, incident and other object writers gave their memories before they took the default. */
export const LEGACY_TYPED_HALF_LIFE = 90;
const TYPED_SOURCES: ReadonlySet<string> = new Set(['decision', 'incident', 'process', 'policy', 'skill', 'project_brief', 'customer_note']);
const OBJECT_TABLES = ['decisions', 'incidents', 'processes', 'policies', 'skills', 'project_briefs', 'customer_notes'] as const;

export { HALF_LIFE_BASE_META_KEY };

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
  const db = openHippoDb(hippoRoot);
  try {
    return readBase(db);
  } finally {
    closeHippoDb(db);
  }
}

function readBase(db: DatabaseSyncLike): number {
  const raw = Number(getMeta(db, HALF_LIFE_BASE_META_KEY, String(LEGACY_HALF_LIFE_BASE)));
  return Number.isFinite(raw) && raw > 0 ? raw : LEGACY_HALF_LIFE_BASE;
}

/**
 * Move the store's memories from the base they are on, and those of objects from
 * the old flat 90 days, to `to`, once. Under `dryRun` nothing is written, the recorded
 * base included.
 */
export function migrateDefaultHalfLife(hippoRoot: string, to: number, opts: { dryRun?: boolean; actor?: string } = {}): HalfLifeMigrationResult {
  const dryRun = opts.dryRun ?? false;
  const noop = (from: number): HalfLifeMigrationResult => ({ from, to, rescaled: 0, typed: 0, kept: 0, dryRun, halfLives: new Map() });
  const db = openStore(hippoRoot);
  try {
    // Plan, write, audit and record the base under one write lock, so a concurrent write or sleep cannot interleave.
    if (!dryRun) db.exec('BEGIN IMMEDIATE');
    try {
      const from = readBase(db);
      const typedPending = getMeta(db, TYPED_HALF_LIFE_META_KEY, '') === '';
      if (!(Number.isFinite(to) && to > 0) || (from === to && !typedPending)) {
        if (!dryRun) db.exec('COMMIT');
        return noop(from);
      }
      const all = selectAllEntries(db);
      const retired = typedPending ? retiredObjectMemoryIds(db) : new Set<string>();
      // Only the typed plan moves a memory an object writer pinned to 90 days. A supersede copy keeps the object's source but was written on the base.
      const pinnedTo90 = (e: MemoryEntry) => TYPED_SOURCES.has(e.source) && halfLifeRecallBonus(e, LEGACY_TYPED_HALF_LIFE) !== null;
      const typedPlan = typedPending ? planTypedHalfLifeMigration(all.filter((e) => !retired.has(e.id)), to) : [];
      const basePlan = planHalfLifeMigration(typedPending ? all.filter((e) => !pinnedTo90(e)) : all, from, to);
      const plan = [...basePlan, ...typedPlan];
      const halfLives = new Map(plan.map((e) => [e.id, e.half_life_days]));
      const result: HalfLifeMigrationResult = { from, to, rescaled: basePlan.length, typed: typedPlan.length, kept: all.length - plan.length, dryRun, halfLives };
      if (dryRun) return result;

      const old = new Map(all.map((e) => [e.id, e.half_life_days]));
      const actor = opts.actor ?? 'system';
      writePlan(db, basePlan, old, { from, to, actor });
      writePlan(db, typedPlan, old, { from: LEGACY_TYPED_HALF_LIFE, to, actor });
      setMeta(db, HALF_LIFE_BASE_META_KEY, String(to));
      setMeta(db, TYPED_HALF_LIFE_META_KEY, '1');
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (!dryRun) db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    closeHippoDb(db);
  }
}

/** Memories behind a superseded or closed object. Retiring an object leaves its memory untouched, so only its table knows. */
function retiredObjectMemoryIds(db: DatabaseSyncLike): Set<string> {
  const ids = new Set<string>();
  for (const table of OBJECT_TABLES) {
    // SAFETY: SELECT of one TEXT column, filtered to non-null.
    const rows = db.prepare(`SELECT memory_id FROM ${table} WHERE memory_id IS NOT NULL AND status IN ('superseded', 'closed')`).all() as { memory_id: string }[];
    for (const r of rows) ids.add(r.memory_id);
  }
  return ids;
}

/** Writes `plan`, then one audit event per tenant with each id's old half-life, so the move can be undone. */
function writePlan(db: DatabaseSyncLike, plan: readonly MemoryEntry[], old: ReadonlyMap<string, number>, move: { from: number; to: number; actor: string }): void {
  const update = db.prepare('UPDATE memories SET half_life_days = ? WHERE id = ?');
  const byTenant = new Map<string, Record<string, number>>();
  for (const e of plan) {
    update.run(e.half_life_days, e.id);
    byTenant.set(e.tenantId, { ...byTenant.get(e.tenantId), [e.id]: old.get(e.id)! });
  }
  for (const [tenantId, oldHalfLives] of byTenant) {
    appendAuditEvent(db, { tenantId, actor: move.actor, op: 'half_life_migrate', metadata: { from: move.from, to: move.to, ids: Object.keys(oldHalfLives), oldHalfLives } });
  }
}
