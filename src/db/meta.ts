import type { DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';

export function ensureMetaTable(db: DatabaseSyncLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getSchemaVersion(db: DatabaseSyncLike): number {
  if (!tableExists(db, 'meta')) return 0;
  // SAFETY: row's shape matches the single `value` column named in the
  // SELECT above.
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: string } | undefined;
  const version = Number(row?.value ?? 0);
  return Number.isFinite(version) ? version : 0;
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

export function isFtsAvailable(db: DatabaseSyncLike): boolean {
  return getMeta(db, 'fts5_available', '0') === '1';
}
