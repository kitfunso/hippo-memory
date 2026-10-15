// The dead-letter statements both connectors share; each connector names its table and columns and maps rows to its own
// item type.

import type { DatabaseSyncLike } from '../../db/index.js';
import { placeholders } from '../../util/sql.js';

export type DlqTable = 'slack_dlq' | 'github_dlq';

// The driver returns each column by its stored affinity; the connector's rowToItem coerces every field.
export type DlqRawValue = string | number | bigint | null;
export type DlqRawRow = Record<string, DlqRawValue>;

/** Inserts one row, stamping received_at; `columns` pairs each column name with its value, in insert order. */
export function insertDlqRow(
  db: DatabaseSyncLike,
  table: DlqTable,
  columns: ReadonlyArray<readonly [string, string | null]>,
): number {
  const names = [...columns.map(([name]) => name), 'received_at'];
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
  // SAFETY: the caller's selectColumns names exactly the fields its rowToItem reads.
  const row = db
    .prepare(`SELECT ${selectColumns} FROM ${table} WHERE id = ?`)
    .get(id) as DlqRawRow | undefined;
  return row ?? null;
}

export function markDlqRetried(db: DatabaseSyncLike, table: DlqTable, id: number): void {
  db.prepare(`UPDATE ${table} SET retried_at = ?, retry_count = retry_count + 1 WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

type DlqKind = 'int' | 'text' | 'nullableText' | 'count' | 'bucket';

/** One DLQ column: the item field it fills, its kind, and whether insert writes it (the database sets the rest). */
export interface DlqColumn {
  field: string;
  column: string;
  kind: DlqKind;
  insert?: true;
}

function coerceDlqValue(kind: DlqKind, raw: DlqRawValue | undefined): string | number | null {
  switch (kind) {
    case 'int': return Number(raw);
    case 'count': return Number(raw ?? 0);
    case 'text': return String(raw);
    case 'nullableText': return raw == null ? null : String(raw);
    case 'bucket': return raw == null ? 'parse_error' : String(raw);
  }
}

export interface DlqAccess<Item, Insert> {
  insert(db: DatabaseSyncLike, row: Insert): number;
  list(db: DatabaseSyncLike, tenantId: string, limit: number): Item[];
  get(db: DatabaseSyncLike, id: number): Item | null;
  markRetried(db: DatabaseSyncLike, id: number): void;
}

/** The four statements and the row mapping of one dead-letter table, driven by its column map. */
export function dlqAccess<Item, Insert extends object>(
  table: DlqTable,
  columns: readonly DlqColumn[],
): DlqAccess<Item, Insert> {
  const selectColumns = columns.map((c) => c.column).join(', ');
  const insertColumns = columns.filter((c) => c.insert);
  // SAFETY: the column map names every field of Item with the kind that coerces it.
  const toItem = (raw: DlqRawRow): Item => Object.fromEntries(
    columns.map((c) => [c.field, coerceDlqValue(c.kind, raw[c.column])]),
  ) as Item;
  return {
    insert: (db, row) => {
      // SAFETY: every insert field of the column map is a string, null or absent on Insert.
      const fields = row as Record<string, string | null | undefined>;
      const pairs = insertColumns.map((c) => [c.column, fields[c.field] ?? null] as const);
      return insertDlqRow(db, table, pairs);
    },
    list: (db, tenantId, limit) => listDlqRows(db, table, selectColumns, tenantId, limit).map(toItem),
    get: (db, id) => {
      const row = getDlqRow(db, table, selectColumns, id);
      return row ? toItem(row) : null;
    },
    markRetried: (db, id) => markDlqRetried(db, table, id),
  };
}
