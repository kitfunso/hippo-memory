import type { StoreWith } from '../../base/ports/store.js';
import type { SleepBegin, SleepStart } from '../../base/ports/store/consolidation.js';

/** What {@link migrateDefaultHalfLife} did, or would do under `dryRun`. */
export interface HalfLifeMigrationResult {
  from: number;
  to: number;
  rescaled: number;
  typed: number;
  kept: number;
  dryRun: boolean;
  halfLives: ReadonlyMap<string, number>;
  start: SleepStart;
}

/** Move the store's memories, and those of objects on the old flat 90 days, from their recorded
 * base to `to`, once, as the store's sleep upkeep begins; `dryRun` writes nothing. */
export async function migrateDefaultHalfLife(
  store: StoreWith<'consolidation'>,
  to: number,
  opts: { dryRun?: boolean; actor?: string; traces?: SleepBegin['traces'] } = {},
): Promise<HalfLifeMigrationResult> {
  const dryRun = opts.dryRun ?? false;
  const actor = opts.actor ?? 'system';
  const start = await store.consolidation.begin(to, { dryRun, actor, traces: opts.traces });
  const { from, outcome } = start;
  const moved = outcome ?? { rescaled: 0, typed: 0, kept: 0, halfLives: new Map<string, number>() };
  return {
    from,
    to,
    rescaled: moved.rescaled,
    typed: moved.typed,
    kept: moved.kept,
    dryRun,
    halfLives: moved.halfLives,
    start,
  };
}
