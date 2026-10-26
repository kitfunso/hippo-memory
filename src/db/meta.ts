import { compareSemver } from '../base/util/version.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { tableExists } from './tables.js';
import { cachedStatement } from './statement-cache.js';

export const META_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

/** Every key the `meta` table holds, so the writers and the readers cannot spell one two ways. */
export const META_KEY = {
  schemaVersion: 'schema_version',
  minCompatibleBinary: 'min_compatible_binary',
  fts5Available: 'fts5_available',
  ftsInSync: 'fts_in_sync',
  embeddingModel: 'embedding_model',
  halfLifeBase: 'default_half_life_base',
  typedHalfLife: 'typed_half_life_on_default',
  lastRetrievalIds: 'last_retrieval_ids',
  lastTraceId: 'last_trace_id',
  totalRemembered: 'total_remembered',
  totalRecalled: 'total_recalled',
  totalForgotten: 'total_forgotten',
  sleepCount: 'sleep_count',
  legacyBootstrapCompleted: 'legacy_bootstrap_completed',
  qualityRepairAuto: 'quality_repair_auto',
  projectRepairAuto: 'project_repair_auto',
} as const;

export function ensureMetaTable(db: DatabaseSyncLike): void {
  db.exec(META_TABLE_DDL);
}

export function getSchemaVersion(db: DatabaseSyncLike): number {
  if (!tableExists(db, 'meta')) return 0;
  const row = cachedStatement(
    db,
    `SELECT value FROM meta WHERE key = '${META_KEY.schemaVersion}'`,
  ).get() as { value?: string } | undefined;
  const version = Number(row?.value ?? 0);
  return Number.isFinite(version) ? version : 0;
}

/** SQLite's own `user_version` stamp, which can differ from the `meta` schema_version row. */
export function pragmaUserVersion(db: DatabaseSyncLike): number {
  // SAFETY: PRAGMA user_version always answers one row.
  return (cachedStatement(db, 'PRAGMA user_version').get() as { user_version: number })
    .user_version;
}

/** The connection's commit counter: it moves when another connection commits. */
export function pragmaDataVersion(db: DatabaseSyncLike): number {
  // SAFETY: PRAGMA data_version always answers one row.
  return (cachedStatement(db, 'PRAGMA data_version').get() as { data_version: number })
    .data_version;
}

export function setSchemaVersion(db: DatabaseSyncLike, version: number): void {
  cachedStatement(
    db,
    `INSERT INTO meta(key, value) VALUES('${META_KEY.schemaVersion}', ?) ON CONFLICT(key) DO UPDATE SET ` +
      `value=excluded.value`,
  ).run(String(version));
  db.exec(`PRAGMA user_version = ${Math.max(0, Math.trunc(version))}`);
}

export function getMeta(db: DatabaseSyncLike, key: string, fallback = ''): string {
  const row = cachedStatement(db, `SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? fallback;
}

/** A counter stored as text; a missing or unreadable value counts as 0. */
export function getMetaNumber(db: DatabaseSyncLike, key: string): number {
  return Number(getMeta(db, key, '0')) || 0;
}

export function setMeta(db: DatabaseSyncLike, key: string, value: string): void {
  cachedStatement(
    db,
    `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}

/**
 * Raise min_compatible_binary to `version`; never lowers it, since an older floor would let back in a binary a newer
 * write already shut out.
 */
export function raiseMinBinary(db: DatabaseSyncLike, version: string): void {
  const existing = getMeta(db, META_KEY.minCompatibleBinary);
  if (!existing || compareSemver(version, existing) > 0)
    setMeta(db, META_KEY.minCompatibleBinary, version);
}

export function isFtsAvailable(db: DatabaseSyncLike): boolean {
  return getMeta(db, META_KEY.fts5Available, '0') === '1';
}
