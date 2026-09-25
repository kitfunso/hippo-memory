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
 * (7 days when never recorded) to the configured `defaultHalfLifeDays`.
 */
import { deriveHalfLife, type MemoryEntry } from './memory.js';
import { initStore, selectAllEntries, HALF_LIFE_BASE_META_KEY } from './store.js';
import { openHippoDb, closeHippoDb, getMeta, setMeta, type DatabaseSyncLike } from './db.js';
import { appendAuditEvent } from './audit.js';

/** The base every store used before the base was recorded. */
export const LEGACY_HALF_LIFE_BASE = 7;

export { HALF_LIFE_BASE_META_KEY };

/** What {@link migrateDefaultHalfLife} did, or would do under `dryRun`. */
export interface HalfLifeMigrationResult {
  from: number;
  to: number;
  /** Memories moved to the new base. */
  rescaled: number;
  /** Memories left alone because they are not on the old base. */
  kept: number;
  dryRun: boolean;
  /** New half-life per moved id, so a dry run can preview decay at the new base. */
  halfLives: ReadonlyMap<string, number>;
}

type HalfLifeFields = Pick<MemoryEntry, 'half_life_days' | 'tags' | 'schema_fit' | 'retrieval_count' | 'superseded_by'>;

/** Recall bonus over what `base` gave `entry`, or null when off that base; pre-1.46 recalls each added 2 days. */
export function halfLifeRecallBonus(entry: HalfLifeFields, base: number): number | null {
  if (entry.superseded_by || entry.tags.includes('invalidated') || entry.tags.includes('superseded')) return null;
  const bonus = entry.half_life_days - deriveHalfLife(base, entry);
  const k = Math.round(bonus / 2);
  return Math.abs(bonus - 2 * k) < 1e-9 && k >= 0 && k <= entry.retrieval_count ? bonus : null;
}

/** The entries to rescale from `from` to `to`, as copies that keep their recall bonus. Pure. */
export function planHalfLifeMigration(entries: readonly MemoryEntry[], from: number, to: number): MemoryEntry[] {
  if (from === to) return [];
  return entries.flatMap((e) => {
    const bonus = halfLifeRecallBonus(e, from);
    return bonus === null ? [] : [{ ...e, half_life_days: deriveHalfLife(to, e) + bonus }];
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
 * Move the store's memories from the base they are on to `to`. A no-op when
 * they are already on it. Under `dryRun` nothing is written, the recorded
 * base included.
 */
export function migrateDefaultHalfLife(hippoRoot: string, to: number, opts: { dryRun?: boolean; actor?: string } = {}): HalfLifeMigrationResult {
  const dryRun = opts.dryRun ?? false;
  const noop = (from: number): HalfLifeMigrationResult => ({ from, to, rescaled: 0, kept: 0, dryRun, halfLives: new Map() });
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    // Plan, write, audit and record the base under one write lock, so a concurrent write or sleep cannot interleave.
    if (!dryRun) db.exec('BEGIN IMMEDIATE');
    try {
      const from = readBase(db);
      if (!(Number.isFinite(to) && to > 0) || from === to) {
        if (!dryRun) db.exec('COMMIT');
        return noop(from);
      }
      const all = selectAllEntries(db);
      const plan = planHalfLifeMigration(all, from, to);
      const halfLives = new Map(plan.map((e) => [e.id, e.half_life_days]));
      const result: HalfLifeMigrationResult = { from, to, rescaled: plan.length, kept: all.length - plan.length, dryRun, halfLives };
      if (dryRun) return result;

      const old = new Map(all.map((e) => [e.id, e.half_life_days]));
      const update = db.prepare('UPDATE memories SET half_life_days = ? WHERE id = ?');
      const byTenant = new Map<string, Record<string, number>>();
      for (const e of plan) {
        update.run(e.half_life_days, e.id);
        byTenant.set(e.tenantId, { ...byTenant.get(e.tenantId), [e.id]: old.get(e.id)! });
      }
      for (const [tenantId, oldHalfLives] of byTenant) {
        appendAuditEvent(db, { tenantId, actor: opts.actor ?? 'system', op: 'half_life_migrate', metadata: { from, to, ids: Object.keys(oldHalfLives), oldHalfLives } });
      }
      setMeta(db, HALF_LIFE_BASE_META_KEY, String(to));
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
