// Moves a store's memories still on an old default half-life base to a new one, once, audit-logged; the plan is
// src/base/memory/half-life-plan.ts, which the store runs inside the move's own transaction.
import type { StoreWith } from '../../store/port.js';

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

/** Move the store's memories, and those of objects on the old flat 90 days, from their recorded base to `to`, once;
 * `dryRun` writes nothing. */
export async function migrateDefaultHalfLife(
  store: StoreWith<'consolidation'>,
  to: number,
  opts: { dryRun?: boolean; actor?: string } = {},
): Promise<HalfLifeMigrationResult> {
  const dryRun = opts.dryRun ?? false;
  const { from, outcome } = await store.consolidation.moveHalfLives(to, { dryRun, actor: opts.actor ?? 'system' });
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
