import { PACKAGE_VERSION, compareSemver } from '../version.js';
import { log } from '../log.js';
import { importLegacyEmbeddingIndex } from '../vector-store.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { execWithBusyRetry } from './busy.js';
import { tableExists } from './tables.js';
import { ensureMetaTable, getMeta, getSchemaVersion, setMeta, setSchemaVersion } from './meta.js';
import { ensureContinuityIndexes, ensureContinuityTables } from './continuity.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.js';

export function getCurrentSchemaVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

/** Thrown by {@link assertBinaryCompatible}; doctor uses it to pick the upgrade fix over a generic permissions fix. */
export class IncompatibleBinaryError extends Error {}

/** Refuse a store stamped for a newer binary. Fails closed: runMigrations creates meta first, so a failed read is a real error. */
export function assertBinaryCompatible(db: DatabaseSyncLike): void {
  const minRequired = getMeta(db, 'min_compatible_binary');
  if (minRequired && compareSemver(minRequired, PACKAGE_VERSION) > 0) {
    throw new IncompatibleBinaryError(
      `hippo-memory: this database requires hippo-memory >= ${minRequired}, but the running binary is ${PACKAGE_VERSION}. ` +
      `Upgrade hippo-memory to open it; an older binary does not know this schema and could expose private rows or damage the store.`,
    );
  }
}

export function runMigrations(db: DatabaseSyncLike, hippoRoot?: string, busyWaitMs?: number): void {
  ensureMetaTable(db);
  // Before anything writes, so a stale binary never repairs or migrates a store it does not understand.
  assertBinaryCompatible(db);

  let currentVersion = getSchemaVersion(db);
  if (currentVersion > 0) ensureContinuityTables(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    execWithBusyRetry(db, 'BEGIN IMMEDIATE', busyWaitMs);
    try {
      // A newer binary may have migrated and raised the minimum while we waited for the lock.
      assertBinaryCompatible(db);
      // Re-read under the write lock: another process may have applied this
      // migration while we waited, and re-running one is not idempotent.
      const applied = getSchemaVersion(db);
      if (applied >= migration.version) {
        db.exec('COMMIT');
        currentVersion = applied;
        continue;
      }
      migration.up(db, { hippoRoot });
      setSchemaVersion(db, migration.version);
      db.exec('COMMIT');
      currentVersion = migration.version;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
      throw error;
    }
  }

  ensureContinuityIndexes(db);
  ensureMetaDefaults(db);
  ensureOptionalFts(db);
  if (hippoRoot) importLegacyVectors(db, hippoRoot);
}

// A failed import leaves embeddings.json in place for the next open to retry; the store still opens.
function importLegacyVectors(db: DatabaseSyncLike, hippoRoot: string): void {
  try {
    importLegacyEmbeddingIndex(db, hippoRoot);
  } catch (err) {
    log.warn(`embeddings.json import failed; the next open retries it (${err instanceof Error ? err.message : String(err)})`, { hippoRoot });
  }
}

function ensureMetaDefaults(db: DatabaseSyncLike): void {
  const defaults: Array<[string, string]> = [
    ['schema_version', String(CURRENT_SCHEMA_VERSION)],
    ['last_retrieval_ids', '[]'],
    ['last_trace_id', ''],
    ['total_remembered', '0'],
    ['total_recalled', '0'],
    ['total_forgotten', '0'],
    ['fts5_available', '0'],
  ];

  // Read-first: an already-current store has all 7 keys, so this is one
  // SELECT and zero writes instead of 7 no-op INSERT OR IGNOREs, each of
  // which takes a RESERVED lock even when nothing changes.
  const keys = defaults.map(([key]) => key);
  const present = new Set(
    (db
      .prepare(`SELECT key FROM meta WHERE key IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as Array<{ key: string }>)
      .map((r) => r.key),
  );
  if (present.size === defaults.length) return;

  const stmt = db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)`);
  for (const [key, value] of defaults) {
    if (!present.has(key)) stmt.run(key, value);
  }
}

function ensureOptionalFts(db: DatabaseSyncLike): void {
  let available = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tags)`);
    backfillFtsIndex(db);
    available = true;
  } catch (err) {
    log.warn(`full-text index unavailable (${err instanceof Error ? err.message : String(err)}); search falls back to slower LIKE matching`);
  }

  // Read-first: only write when the flag actually changed, so a healthy
  // store's open doesn't take a write lock for a same-value upsert.
  const flag = available ? '1' : '0';
  if (getMeta(db, 'fts5_available') !== flag) setMeta(db, 'fts5_available', flag);
}

function backfillFtsIndex(db: DatabaseSyncLike): void {
  // SAFETY: this get() result's shape matches the single aliased `c` column
  // named in the SELECT above.
  const memCount = (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c?: number } | undefined)?.c ?? 0;
  // SAFETY: this get() result's shape matches the single aliased `c` column named in the SELECT above.
  // memories_fts_docsize is FTS5's cheaper one-row-per-document shadow table; fall back for a foreign-built index.
  const ftsTable = tableExists(db, 'memories_fts_docsize') ? 'memories_fts_docsize' : 'memories_fts';
  const ftsCount = (db.prepare(`SELECT COUNT(*) AS c FROM ${ftsTable}`).get() as { c?: number } | undefined)?.c ?? 0;
  if (memCount === ftsCount) return;

  db.exec(`
    INSERT INTO memories_fts(id, content, tags)
    SELECT m.id, m.content, m.tags_json
    FROM memories m
    WHERE NOT EXISTS (
      SELECT 1 FROM memories_fts f WHERE f.id = m.id
    )
  `);

  db.exec(`
    DELETE FROM memories_fts
    WHERE id NOT IN (SELECT id FROM memories)
  `);
}
