// The dead-letter statements both connectors share; each connector names its table and columns and maps rows to its own
// item type.

import type { DatabaseSyncLike } from '../../db/index.js';
import { placeholders } from '../../util/sql.js';

export type DlqTable = 'slack_dlq' | 'github_dlq';

const DLQ_TABLES: readonly string[] = ['slack_dlq', 'github_dlq'];
const COLUMN_NAME = /^[a-z_]+$/;

// The statements splice identifiers into SQL, so the typed union is backed by a runtime check.
function assertTable(table: string): void {
  if (!DLQ_TABLES.includes(table)) throw new Error(`Invalid DLQ table: ${table}`);
}

function assertColumns(names: readonly string[]): void {
  for (const name of names) {
    if (!COLUMN_NAME.test(name)) throw new Error(`Invalid DLQ column name: ${name}`);
  }
}

// The driver returns each column by its stored affinity; the connector's rowToItem coerces every field.
export type DlqRawValue = string | number | bigint | null;
export type DlqRawRow = Record<string, DlqRawValue>;

/** Inserts one row, stamping received_at; `columns` pairs each column name with its value, in insert order. */
export function insertDlqRow(
  db: DatabaseSyncLike,
  table: DlqTable,
  columns: ReadonlyArray<readonly [string, string | null]>,
): number {
  assertTable(table);
  const names = [...columns.map(([name]) => name), 'received_at'];
  assertColumns(names);
  const values = [...columns.map(([, value]) => value), new Date().toISOString()];
  const result = db
    .prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders(names.length)})`)
    .run(...values);
  return Number(result.lastInsertRowid);
}

export function listDlqRows(
  db: DatabaseSyncLike,
  table: DlqTable,
  selectColumns: string,
  tenantId: string,
  limit: number,
): DlqRawRow[] {
  assertTable(table);
  assertColumns(selectColumns.split(',').map((name) => name.trim()));
  // SAFETY: the caller's selectColumns names exactly the fields its rowToItem reads.
  return db
    .prepare(
      `SELECT ${selectColumns}
         FROM ${table}
        WHERE tenant_id = ?
        ORDER BY received_at ASC
        LIMIT ?`,
    )
    .all(tenantId, limit) as DlqRawRow[];
}

export function getDlqRow(db: DatabaseSyncLike, table: DlqTable, selectColumns: string, id: number): DlqRawRow | null {
  assertTable(table);
  assertColumns(selectColumns.split(',').map((name) => name.trim()));
  // SAFETY: the caller's selectColumns names exactly the fields its rowToItem reads.
  const row = db
    .prepare(`SELECT ${selectColumns} FROM ${table} WHERE id = ?`)
    .get(id) as DlqRawRow | undefined;
  return row ?? null;
}

export function markDlqRetried(db: DatabaseSyncLike, table: DlqTable, id: number): void {
  assertTable(table);
  db.prepare(`UPDATE ${table} SET retried_at = ?, retry_count = retry_count + 1 WHERE id = ?`)
    .run(new Date().toISOString(), id);
}
