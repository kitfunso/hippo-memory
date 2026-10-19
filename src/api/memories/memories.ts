// Memory reads for the CLI verbs: one row by id, the tenant's rows, or with a host admin every tenant's.
import type { MemoryEntry } from '../../core/memory.js';
import type { StrengthTallies } from '../../store/port/reports.js';
import { NotFoundError } from '../../core/api-errors.js';
import { canTouchScope } from '../../core/recall-scope.js';
import type { HippoStore } from '../../store/port.js';
import { requireHostAdmin, type Context } from '../types.js';
import { ALL_TENANTS, type TenantId } from '../../util/tenant.js';
import type { EntryCursor } from '../../store/port/types.js';

/** The row `id` in the caller's tenant, or null when it is missing or another tenant's. */
export async function memoryGet(ctx: Context, id: string): Promise<MemoryEntry | null> {
  const [entry] = await ctx.store.entriesByIds([id], ctx.tenantId);
  return entry ?? null;
}

/** memoryGet, but NotFound when the row is another person's
 * personal one, so the reply does not reveal that the id exists. */
export async function memoryGetTouchable(ctx: Context, id: string): Promise<MemoryEntry | null> {
  const entry = await memoryGet(ctx, id);
  if (!canTouchScope(ctx.actor, entry?.scope ?? null)) throw new NotFoundError(`Memory not found: ${id}`);
  return entry;
}

export interface MemoryStatus extends StrengthTallies {
  openConflicts: number;
}

/** Tenant-wide counts behind the status verbs: strength tallies
 * at `now` (at risk is under `atRiskBelow`) and open conflicts. */
export function memoryStatusGet(ctx: Context, now: Date, atRiskBelow: number): Promise<MemoryStatus> {
  return ctx.store.reports.memoryStatus(ctx.tenantId, now, atRiskBelow);
}

/** Which rows a read covers: the caller's tenant, or with `everyTenant` the whole store. */
export interface TenantReach {
  everyTenant?: boolean;
}

function tenantFilter(ctx: Context, reach: TenantReach): TenantId {
  if (!reach.everyTenant) return ctx.tenantId;
  requireHostAdmin(ctx, 'Reading every tenant');
  return ALL_TENANTS;
}

/** Rows a listing reads per query by default; the verbs still receive every row. */
const LIST_PAGE_SIZE = 1000;

/** The tenant's memory rows, oldest first, `pageSize` per query, so a pass can hold one page. */
export async function* memoryPages(
  store: HippoStore,
  tenant: TenantId,
  pageSize: number = LIST_PAGE_SIZE,
): AsyncGenerator<MemoryEntry[]> {
  const limit = Math.max(1, Math.trunc(pageSize));
  let after: EntryCursor | undefined;
  do {
    const page = await store.reports.entriesPage(tenant, { limit, after });
    yield page.entries;
    after = page.next ?? undefined;
  } while (after);
}

/** Every memory row in reach, oldest first, read `pageSize` rows per query so no single read grows with the store. */
export async function memoryList(
  ctx: Context,
  reach: TenantReach = {},
  opts: { pageSize?: number } = {},
): Promise<MemoryEntry[]> {
  const all: MemoryEntry[] = [];
  for await (const page of memoryPages(ctx.store, tenantFilter(ctx, reach), opts.pageSize)) all.push(...page);
  return all;
}

/** How many memory rows the whole store holds, counted in SQL. */
export async function memoryCountAll(ctx: Context): Promise<number> {
  requireHostAdmin(ctx, 'Reading every tenant');
  return ctx.store.reports.countEntries();
}

/** The rows in reach among `ids`; a missing id or one out of reach is absent. */
export async function memoryListByIds(
  ctx: Context,
  ids: readonly string[],
  reach: TenantReach = {},
): Promise<MemoryEntry[]> {
  return ctx.store.entriesByIds(ids, tenantFilter(ctx, reach));
}
