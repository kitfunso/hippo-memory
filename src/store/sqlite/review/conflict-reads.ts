// hippo.db's conflict reads: a page, one conflict, the open count and the open conflicts naming a
// memory, each with both members' columns from one JOIN.
import { ALL_TENANTS, type TenantId } from '../../../base/util/tenant.js';
import { type DatabaseSyncLike } from '../../../db/index.js';
import { MEMORY_CONFLICT_COLUMNS, rowToMemoryConflict } from '../runtime/rows.js';
import type { ConflictWire } from '../../../base/memory/conflict-wire.js';
import { keysetPage } from '../../../base/util/keyset.js';
import type { SqlFragment } from '../../../db/sql.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type {
  ConflictListQuery,
  ConflictMember,
  ConflictRow,
  ConflictRowPage,
} from '../../../base/records/conflicts.js';

// The JOIN with both members' memories rows needs each conflict column qualified, or `id` would
// be ambiguous.
const CONFLICT_COLS_MC = MEMORY_CONFLICT_COLUMNS.split(', ')
  .map((c) => `mc.${c}`)
  .join(', ');

// Each member's columns the api's conflict rules read, aliased per side so one JOIN carries both.
const MEMBER_COLS = ['id', 'scope', 'kind', 'superseded_by', 'origin_project'] as const;
const memberCols = (alias: string, side: string): string =>
  MEMBER_COLS.map((c) => `${alias}.${c} AS ${side}_${c}`).join(', ');
const CONFLICT_ROW_COLS = `${CONFLICT_COLS_MC}, ${memberCols('ma', 'a')}, ${memberCols('mb', 'b')}`;

// SAFETY: every read cast to this row selects CONFLICT_ROW_COLS; scripts/checks/check-row-casts.mjs
// proves it.
interface ConflictJoinRow extends ConflictWire {
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

/** One side's member from its MEMBER_COLS columns; null when the left join found no row. */
function memberOf(r: ConflictJoinRow, side: 'a' | 'b'): ConflictMember | null {
  const id = r[`${side}_id` as const];
  const kind = r[`${side}_kind` as const];
  if (id === null || kind === null) return null;
  return {
    scope: r[`${side}_scope` as const],
    kind,
    supersededBy: r[`${side}_superseded_by` as const],
    originProject: r[`${side}_origin_project` as const],
  };
}

function toConflictRow(r: ConflictJoinRow): ConflictRow {
  return { conflict: rowToMemoryConflict(r), a: memberOf(r, 'a'), b: memberOf(r, 'b') };
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
export function conflictById(
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

/** The conflict and loser ids every conflict_resolve audit row names. */
export function conflictResolveAudits(
  db: DatabaseSyncLike,
): Array<{ conflictId: number; loserId: string }> {
  // SAFETY: every conflict_resolve audit row's metadata holds both ids (ConflictResolveMeta in conflict-resolve.ts).
  return cachedStatement(
    db,
    `SELECT json_extract(metadata_json, '$.conflictId') ` +
      `AS conflictId, json_extract(metadata_json, '$.loserId') AS loserId ` +
      `FROM audit_log WHERE op = 'conflict_resolve'`,
  ).all() as { conflictId: number; loserId: string }[];
}

/** Every resolved conflict with both sides. */
export function resolvedConflicts(
  db: DatabaseSyncLike,
): Array<{ id: number; memory_a_id: string; memory_b_id: string }> {
  return cachedStatement(
    db,
    `SELECT id, memory_a_id, memory_b_id FROM memory_conflicts WHERE status = 'resolved'`,
  ).all() as {
    id: number;
    memory_a_id: string;
    memory_b_id: string;
  }[];
}
