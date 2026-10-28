// hippo.db's origin and source rewrites: rows moved between projects and renamed sources.
import { storedSource } from '../../base/util/secret-detect.js';
import { holdsSourceSql } from './rule-sql.js';
import { type DatabaseSyncLike } from '../../db/index.js';
import type { RenameSourceOptions } from '../../base/ports/store/agent-import.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { lastPerId } from './entry-stats.js';

/** A tenant's project `from` and the project `into` that takes its rows. */
export interface OriginMoveOptions {
  readonly tenantId: string;
  readonly from: string;
  readonly into: string;
}

/** Moves every row of `from` in a tenant to project `into`. */
export function restampOriginProject(
  db: DatabaseSyncLike,
  { tenantId, from, into }: OriginMoveOptions,
): void {
  cachedStatement(
    db,
    `UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND origin_project = ?`,
  ).run(into, tenantId, from);
}

const ORIGIN_STAMP_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS origin FROM json_each(?)) ` +
  `UPDATE memories SET origin_project = v.origin, updated_at = datetime('now') FROM v ` +
  `WHERE memories.id = v.id AND memories.tenant_id = ?`;

/** Stamps each id with its project, in one statement. */
export function stampOriginProjects(
  db: DatabaseSyncLike,
  tenantId: string,
  rows: readonly { id: string; origin: string }[],
): void {
  if (rows.length === 0) return;
  cachedStatement(db, ORIGIN_STAMP_SQL).run(lastPerId(rows.map((r) => [r.id, r.origin])), tenantId);
}

/** A tenant's row `id` and the source names it moves `from` and `to`. */
interface RenameEntrySourceOptions {
  readonly tenantId: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** Renames a live row's source from `from` to `to`; the count is 0 when another writer moved or
 * superseded it first. */
export function renameEntrySource(
  db: DatabaseSyncLike,
  { tenantId, id, from, to }: RenameEntrySourceOptions,
): number {
  const held = holdsSourceSql('source', from);
  const moved = cachedStatement(
    db,
    `UPDATE memories SET source = ? WHERE id = ? AND tenant_id = ? AND ${held.sql} AND superseded_by IS NULL`,
  ).run(storedSource(to), id, tenantId, ...held.params);
  return Number(moved.changes ?? 0);
}

/** Renames a row's source and, when `origin` is not null, its project; the count is 0 when the
 * row is gone or moved. */
export function renameEntrySourceAndOrigin(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  options: RenameSourceOptions,
): number {
  const { from, to, origin } = options;
  const held = holdsSourceSql('source', from);
  const done = cachedStatement(
    db,
    `UPDATE memories SET source = ?, origin_project = COALESCE(?, origin_project) WHERE id = ? AND tenant_id = ? ` +
      `AND ${held.sql}`,
  ).run(storedSource(to), origin, id, tenantId, ...held.params);
  return Number(done.changes ?? 0);
}
