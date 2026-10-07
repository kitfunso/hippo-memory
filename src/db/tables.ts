import type { DatabaseSyncLike } from './sqlite.js';

/** Column names of one table; empty when the table is missing. */
export function tableColumns(db: DatabaseSyncLike, tableName: string): Set<string> {
  if (!/^[a-z_]+$/i.test(tableName)) throw new Error(`Invalid table name: ${tableName}`);
  // SAFETY: rows' shape matches PRAGMA table_info's documented `name` column.
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.flatMap((row) => (row.name === undefined ? [] : [row.name])));
}

export function tableHasColumn(db: DatabaseSyncLike, tableName: string, columnName: string): boolean {
  return tableColumns(db, tableName).has(columnName);
}

export function tableExists(db: DatabaseSyncLike, tableName: string): boolean {
  if (!/^[a-z_]+$/i.test(tableName)) throw new Error(`Invalid table name: ${tableName}`);
  // SAFETY: row's shape matches the single `name` column named in the
  // SELECT above.
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName) as { name?: string } | undefined;
  return !!row?.name;
}

/** Row count of one table; null when the table is missing or unreadable, which callers show as unknown. */
export function countTableRows(db: DatabaseSyncLike, table: string): number | null {
  try {
    // SAFETY: COUNT(*) returns one row with one numeric column.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    // Callers treat an uncountable table as unknown; the bundle and doctor still finish.
    return null;
  }
}

export function pruneConsolidationRuns(db: DatabaseSyncLike, keep = 50): void {
  db.prepare(`
    DELETE FROM consolidation_runs
    WHERE id NOT IN (
      SELECT id FROM consolidation_runs
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    )
  `).run(keep);
}
