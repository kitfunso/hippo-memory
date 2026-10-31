// Memory reads for the CLI verbs: one row by id, the tenant's rows, or with a host admin every tenant's.
import type { MemoryEntry } from '../../core/memory.js';
import type { StrengthTallies } from '../../store/candidates.js';
import { NotFoundError } from '../../core/api-errors.js';
import { canTouchScope } from '../../core/recall-scope.js';
import type { EntryCursor } from '../../store/entry-reads.js';
import { requireHostAdmin, type Context, type ContextWith, type StoreContext } from '../types.js';

/** The row `id` in the caller's tenant, or null when it is missing or another tenant's. */
export async function getMemory(ctx: StoreContext, id: string): Promise<MemoryEntry | null> {
  const [entry] = await ctx.store.entriesByIds([id], ctx.tenantId);
  return entry ?? null;
}

/** getMemory, but NotFound when the row is another person's
 * personal one, so the reply does not reveal that the id exists. */
export async function getTouchableMemory(ctx: StoreContext, id: string): Promise<MemoryEntry | null> {
  const entry = await getMemory(ctx, id);
  if (!canTouchScope(ctx.actor, entry?.scope ?? null)) throw new NotFoundError(`Memory not found: ${id}`);
  return entry;
}

export interface MemoryStatus extends StrengthTallies {
  openConflicts: number;
}

/** Tenant-wide counts behind the status verbs: strength tallies
 * at `now` (at risk is under `atRiskBelow`) and open conflicts. */
export function getMemoryStatus(ctx: ContextWith<'reports'>, now: Date, atRiskBelow: number): Promise<MemoryStatus> {
  return ctx.store.reports.memoryStatus(ctx.tenantId, now, atRiskBelow);
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

/** Rows a listing reads per query by default; the verbs still receive every row. */
const LIST_PAGE_SIZE = 1000;

/** Every memory row in reach, oldest first, read `pageSize` rows per query so no single read grows with the store. */
export async function listMemories(
  ctx: ContextWith<'reports'>,
  reach: TenantReach = {},
  opts: { pageSize?: number } = {},
): Promise<MemoryEntry[]> {
  const tenant = tenantFilter(ctx, reach) ?? null;
  const limit = Math.max(1, Math.trunc(opts.pageSize ?? LIST_PAGE_SIZE));
  const all: MemoryEntry[] = [];
  let after: EntryCursor | undefined;
  do {
    const page = await ctx.store.reports.entriesPage(tenant, { limit, after });
    all.push(...page.entries);
    after = page.next ?? undefined;
  } while (after);
  return all;
}

/** How many memory rows the whole store holds, counted in SQL. */
export async function countAllMemories(ctx: ContextWith<'reports'>): Promise<number> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return ctx.store.reports.countEntries();
}

/** The rows in reach among `ids`; a missing id or one out of reach is absent. */
export async function listMemoriesByIds(
  ctx: StoreContext,
  ids: readonly string[],
  reach: TenantReach = {},
): Promise<MemoryEntry[]> {
  return ctx.store.entriesByIds(ids, tenantFilter(ctx, reach));
}
