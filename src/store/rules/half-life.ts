// Where a store records the half-life base its memories are on, and the audit rows a move leaves, once for both
// adapters; the move itself is planned in src/base/memory/half-life-plan.ts.
import type { HalfLifeMove } from '../../base/memory/half-life-plan.js';
import type { AppendAuditOpts } from '../../base/ports/store/types.js';

/** `meta` key holding the default half-life base a store's memories are on; see
 * src/domain/consolidate/half-life-migration.ts. */
export const HALF_LIFE_BASE_META_KEY = 'default_half_life_base';
/** `meta` key set once no memory of a decision, incident or other object sits on the old flat 90 days. */
export const TYPED_HALF_LIFE_META_KEY = 'typed_half_life_on_default';

/** The base every store used before the base was recorded. */
const LEGACY_HALF_LIFE_BASE = 7;

/** The base a stored meta value names: 7 days when none was recorded or it is not a positive number. */
export function recordedHalfLifeBase(stored: string | undefined): number {
  const raw = Number(stored ?? LEGACY_HALF_LIFE_BASE);
  return Number.isFinite(raw) && raw > 0 ? raw : LEGACY_HALF_LIFE_BASE;
}

/** One row per tenant with each id's old half-life, so the move can be undone. */
export function halfLifeAuditRows(move: HalfLifeMove, actor: string): AppendAuditOpts[] {
  const byTenant = new Map<string, Record<string, number>>();
  for (const e of move.entries) {
    // One record per tenant, filled in place: copying it per row made the write grow with the square of the store.
    let record = byTenant.get(e.tenantId);
    if (!record) byTenant.set(e.tenantId, (record = {}));
    record[e.id] = e.oldHalfLifeDays;
  }
  return [...byTenant].map(([tenantId, oldHalfLives]) => ({
    tenantId,
    actor,
    op: 'half_life_migrate',
    metadata: { from: move.from, to: move.to, ids: Object.keys(oldHalfLives), oldHalfLives },
  }));
}
