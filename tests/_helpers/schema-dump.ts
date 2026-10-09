import type { DatabaseSyncLike } from '../../src/db/index.js';

export interface SchemaDump {
  readonly userVersion: number;
  readonly objects: ReadonlyArray<{ type: string; name: string; sql: string | null }>;
}

/** Every schema object plus PRAGMA user_version, sorted so the dump compares byte for byte. */
export function dumpSchema(db: DatabaseSyncLike): SchemaDump {
  // SAFETY: row shapes follow the selected columns.
  const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all() as Array<{ type: string; name: string; sql: string | null }>;
  // SAFETY: PRAGMA user_version returns one row with one integer column.
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return { userVersion: user_version, objects: objects.map((o) => ({ type: o.type, name: o.name, sql: o.sql })) };
}
