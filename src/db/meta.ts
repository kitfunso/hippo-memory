import { compareSemver } from '../version.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';

export const META_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

export function ensureMetaTable(db: DatabaseSyncLike): void {
  db.exec(META_TABLE_DDL);
}

export function getSchemaVersion(db: DatabaseSyncLike): number {
  if (!tableExists(db, 'meta')) return 0;
  // SAFETY: row's shape matches the single `value` column named in the
  // SELECT above.
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: string } | undefined;
  const version = Number(row?.value ?? 0);
  return Number.isFinite(version) ? version : 0;
}

/** SQLite's own `user_version` stamp, which can differ from the `meta` schema_version row. */
export function pragmaUserVersion(db: DatabaseSyncLike): number {
  // SAFETY: PRAGMA user_version returns one row with one integer column.
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** The connection's commit counter: it moves when another connection commits. */
export function pragmaDataVersion(db: DatabaseSyncLike): number {
  // SAFETY: PRAGMA data_version returns one row with that single integer column.
  return (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
}

export function setSchemaVersion(db: DatabaseSyncLike, version: number): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(version));
  db.exec(`PRAGMA user_version = ${Math.max(0, Math.trunc(version))}`);
}

export function getMeta(db: DatabaseSyncLike, key: string, fallback = ''): string {
  // SAFETY: row's shape matches the single `value` column named in the
  // SELECT above.
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
  return row?.value ?? fallback;
}

export function setMeta(db: DatabaseSyncLike, key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

/** Raise min_compatible_binary to `version`; never lowers it, since an older floor would let back in a binary a newer write already shut out. */
export function raiseMinBinary(db: DatabaseSyncLike, version: string): void {
  const existing = getMeta(db, 'min_compatible_binary');
  if (!existing || compareSemver(version, existing) > 0) setMeta(db, 'min_compatible_binary', version);
}

export function isFtsAvailable(db: DatabaseSyncLike): boolean {
  return getMeta(db, 'fts5_available', '0') === '1';
}
