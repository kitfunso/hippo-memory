// Reads of one memory by id, so a CLI verb asks the api instead of opening the store itself.
import type { MemoryEntry } from '../core/memory.js';
import { loadStrengthTallies, type StrengthTallies } from '../store/candidates.js';
import { countOpenConflicts } from '../store/conflicts.js';
import { NotFoundError } from '../core/api-errors.js';
import { canTouchScope } from '../core/recall-scope.js';
import { storeFor } from '../store/index.js';
import type { Context } from './types.js';

/** The row `id` in the caller's tenant, or null when it is missing or another tenant's. */
export async function getMemory(ctx: Context, id: string): Promise<MemoryEntry | null> {
  const [entry] = await storeFor(ctx).entriesByIds([id], ctx.tenantId);
  return entry ?? null;
}

/** getMemory, but NotFound when the row is another person's personal one, so the reply does not reveal that the id exists. */
export async function getTouchableMemory(ctx: Context, id: string): Promise<MemoryEntry | null> {
  const entry = await getMemory(ctx, id);
  if (!canTouchScope(ctx.actor, entry?.scope ?? null)) throw new NotFoundError(`Memory not found: ${id}`);
  return entry;
}

export interface MemoryStatus extends StrengthTallies {
  openConflicts: number;
}

/** Tenant-wide counts behind the status verbs: strength tallies at `now` (at risk is under `atRiskBelow`) and open conflicts. */
export function getMemoryStatus(ctx: Context, now: Date, atRiskBelow: number): MemoryStatus {
  return {
    ...loadStrengthTallies(ctx.hippoRoot, ctx.tenantId, now, atRiskBelow),
    openConflicts: countOpenConflicts(ctx.hippoRoot, ctx.tenantId),
  };
}
