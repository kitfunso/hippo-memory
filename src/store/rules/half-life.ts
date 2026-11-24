import type { HalfLifeMove } from '../../base/memory/half-life-plan.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';

const LEGACY_HALF_LIFE_BASE = 7;

/** The base a stored meta value names: 7 days when none was recorded or it is not a positive
 * number. */
export function recordedHalfLifeBase(stored: string | undefined): number {
  const raw = Number(stored ?? LEGACY_HALF_LIFE_BASE);
  return Number.isFinite(raw) && raw > 0 ? raw : LEGACY_HALF_LIFE_BASE;
}

/** One row per tenant with each id's old half-life, so the move can be undone. */
export function halfLifeAuditRows(move: HalfLifeMove, actor: string): AppendAuditOptions[] {
  const byTenant = new Map<string, Record<string, number>>();
  for (const e of move.entries) {
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
