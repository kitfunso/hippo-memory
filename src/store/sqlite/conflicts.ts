// hippo.db's Conflicts group: listing and resolving the memory_conflicts rows.
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import { type DatabaseSyncLike } from '../../db/index.js';
import { MEMORY_CONFLICT_COLUMNS, type MemoryConflictRow, rowToMemoryConflict } from './rows.js';
import type { Handles } from './open.js';
import { keysetPage } from '../../base/util/keyset.js';
import type { SqlFragment } from '../../db/sql.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type {
  ConflictListQuery,
  ConflictMember,
  ConflictRow,
  ConflictRowPage,
  Conflicts,
} from '../../base/ports/store/conflicts.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import { resolveConflict } from './conflict-resolution.js';
// The JOIN with both members' memories rows needs each conflict column qualified, or `id` would be
// ambiguous.
const CONFLICT_COLS_MC = MEMORY_CONFLICT_COLUMNS.split(', ')
  .map((c) => `mc.${c}`)
  .join(', ');

// Each member's columns the api's conflict rules read, aliased per side so one JOIN carries both.
const MEMBER_COLS = ['id', 'scope', 'kind', 'superseded_by', 'origin_project'] as const;
const memberCols = (alias: string, side: string): string =>
  MEMBER_COLS.map((c) => `${alias}.${c} AS ${side}_${c}`).join(', ');
const CONFLICT_ROW_COLS = `${CONFLICT_COLS_MC}, ${memberCols('ma', 'a')}, ${memberCols('mb', 'b')}`;

// SAFETY: every read cast to this row selects CONFLICT_ROW_COLS; scripts/check-row-casts.mjs proves
// it.
interface ConflictJoinRow extends MemoryConflictRow {
  a_id: string | null;
  a_scope: string | null;
  a_kind: string | null;
  a_superseded_by: string | null;
  a_origin_project: string | null;
  b_id: string | null;
  b_scope: string | null;
  b_kind: string | null;
  b_superseded_by: string | null;
  b_origin_project: string | null;
}

/** One member's joined columns, each null when the left join found no row. */
interface MemberOfOptions {
  readonly id: string | null;
  readonly scope: string | null;
  readonly kind: string | null;
  readonly supersededBy: string | null;
  readonly originProject: string | null;
}

function memberOf({
  id,
  scope,
  kind,
  supersededBy,
  originProject,
}: MemberOfOptions): ConflictMember | null {
  if (id === null || kind === null) return null;
  return { scope, kind, superseded_by: supersededBy, origin_project: originProject };
}

function toConflictRow(r: ConflictJoinRow): ConflictRow {
  return {
    conflict: rowToMemoryConflict(r),
    a: memberOf({
      id: r.a_id,
      scope: r.a_scope,
      kind: r.a_kind,
      supersededBy: r.a_superseded_by,
      originProject: r.a_origin_project,
    }),
    b: memberOf({
      id: r.b_id,
      scope: r.b_scope,
      kind: r.b_kind,
      supersededBy: r.b_superseded_by,
      originProject: r.b_origin_project,
    }),
  };
}

/** A conflict read's SELECT with its WHERE. With a tenant both members must be in it, so no
 * cross-tenant or stale pair surfaces; with none, every conflict comes back with whichever
 * members still exist. */
function conflictSelect(tenantId: TenantId, filters: readonly SqlFragment[]): SqlFragment {
  const join = tenantId === ALL_TENANTS ? 'LEFT JOIN' : 'JOIN';
  const where: SqlFragment[] =
    tenantId === ALL_TENANTS
      ? [...filters]
      : [
          { sql: 'ma.tenant_id = ? AND mb.tenant_id = ?', params: [tenantId, tenantId] },
          ...filters,
        ];
  return {
    sql:
      `SELECT ${CONFLICT_ROW_COLS} FROM memory_conflicts mc ${join} memories ma ON ma.id = mc.memory_a_id ` +
      `${join} memories mb ON mb.id = mc.memory_b_id` +
      (where.length > 0 ? ` WHERE ${where.map((f) => f.sql).join(' AND ')}` : ''),
    params: where.flatMap((f) => f.params),
  };
}

/** One page of conflicts, newest change first, each with both members' columns from the same
 * JOIN. */
export function conflictPage(
  db: DatabaseSyncLike,
  { tenantId, status, limit, after }: ConflictListQuery,
): ConflictRowPage {
  const filters: SqlFragment[] = [];
  if (status !== '*') filters.push({ sql: 'mc.status = ?', params: [status] });
  if (after) {
    filters.push({ sql: '(mc.updated_at, mc.id) < (?, ?)', params: [after.key, after.id] });
  }
  const select = conflictSelect(tenantId, filters);
  const rows = cachedStatement(
    db,
    `${select.sql} ORDER BY mc.updated_at DESC, mc.id DESC LIMIT ?`,
  ).all(...select.params, limit + 1) as ConflictJoinRow[];
  const page = keysetPage(rows, limit, (row) => ({ key: row.updated_at, id: row.id }));
  return { rows: page.rows.map(toConflictRow), next: page.next };
}

/** Conflict `conflictId`, any status, when both its members are in `tenantId`. */
function conflictById(
  db: DatabaseSyncLike,
  tenantId: string,
  conflictId: number,
): ConflictRow | null {
  const select = conflictSelect(tenantId, [{ sql: 'mc.id = ?', params: [conflictId] }]);
  const row = cachedStatement(db, select.sql).get(...select.params) as ConflictJoinRow | undefined;
  return row ? toConflictRow(row) : null;
}

// The tenanted open set: both members in the tenant.
const OPEN_IN_TENANT = `FROM memory_conflicts mc
  JOIN memories ma ON ma.id = mc.memory_a_id
  JOIN memories mb ON mb.id = mc.memory_b_id
  WHERE mc.status = 'open' AND ma.tenant_id = ? AND mb.tenant_id = ?`;

/** countOpenConflicts on a handle the caller holds, so it can share a snapshot with other reads. */
export function countOpenConflicts(db: DatabaseSyncLike, tenantId: string): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(db, `SELECT COUNT(*) AS n ${OPEN_IN_TENANT}`).get(
    tenantId,
    tenantId,
  ) as {
    n: number | bigint;
  };
  return Number(row.n);
}

/** The tenant's open conflicts naming `memoryId`, newest change first, each with both members'
 * columns. */
export function openConflictsNaming(
  db: DatabaseSyncLike,
  tenantId: string,
  memoryId: string,
): ConflictRow[] {
  const select = conflictSelect(tenantId, [
    { sql: `mc.status = 'open'`, params: [] },
    { sql: '(mc.memory_a_id = ? OR mc.memory_b_id = ?)', params: [memoryId, memoryId] },
  ]);
  const rows = cachedStatement(db, `${select.sql} ORDER BY mc.updated_at DESC, mc.id DESC`).all(
    ...select.params,
  ) as ConflictJoinRow[];
  return rows.map(toConflictRow);
}

const conflictsBodies: Bodies<Omit<Conflicts, 'resolve'>> = {
  list: conflictPage,
  get: conflictById,
};

export function sqliteConflicts({ on, files }: Handles): Conflicts {
  return {
    ...bound(on, conflictsBodies, openStore),
    ...bound<Pick<Conflicts, 'resolve'>>(
      on,
      { resolve: (db, ...args) => resolveConflict(db, files, ...args) },
      openStore,
    ),
  };
}
