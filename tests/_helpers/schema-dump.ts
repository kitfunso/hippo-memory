import type { DatabaseSyncLike } from '../../src/db/index.js';

export interface SchemaDump {
  readonly userVersion: number;
  readonly objects: readonly string[];
}

/** DDL with its comments dropped and its whitespace collapsed: layout is not schema, so it is not pinned. */
export function flatSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** Every schema object as one `type name: sql` line plus PRAGMA user_version, sorted so the dump compares line by line. */
export function dumpSchema(db: DatabaseSyncLike): SchemaDump {
  // SAFETY: row shapes follow the selected columns.
  const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all() as Array<{
    type: string;
    name: string;
    sql: string | null;
  }>;
  // SAFETY: PRAGMA user_version returns one row with one integer column.
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return {
    userVersion: user_version,
    objects: objects.map((o) => `${o.type} ${o.name}${o.sql === null ? '' : `: ${flatSql(o.sql)}`}`),
  };
}
