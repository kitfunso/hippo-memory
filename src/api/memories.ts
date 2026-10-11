// Memory reads for the CLI verbs: one row by id, the tenant's rows, or with a host admin every tenant's.
import type { MemoryEntry } from '../core/memory.js';
import { loadStrengthTallies, type StrengthTallies } from '../store/candidates.js';
import { countOpenConflicts } from '../store/conflicts.js';
import { NotFoundError } from '../core/api-errors.js';
import { canTouchScope } from '../core/recall-scope.js';
import { storeFor } from '../store/index.js';
import { loadAllEntries, loadEntriesByIds } from '../store/entry-reads.js';
import { requireHostAdmin, type Context } from './types.js';

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

/** Which rows a read covers: the caller's tenant, or with `everyTenant` the whole store. */
export interface TenantReach {
  everyTenant?: boolean;
}

function tenantFilter(ctx: Context, reach: TenantReach): string | undefined {
  if (!reach.everyTenant) return ctx.tenantId;
  requireHostAdmin(ctx, 'Reading every tenant');
  return undefined;
}

/** Every memory row in reach, oldest first. */
export function listMemories(ctx: Context, reach: TenantReach = {}): MemoryEntry[] {
  return loadAllEntries(ctx.hippoRoot, tenantFilter(ctx, reach));
}

/** The rows in reach among `ids`; a missing id or one out of reach is absent. */
export function listMemoriesByIds(ctx: Context, ids: readonly string[], reach: TenantReach = {}): MemoryEntry[] {
  return loadEntriesByIds(ctx.hippoRoot, ids, tenantFilter(ctx, reach));
}
