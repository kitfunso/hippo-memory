import { PACKAGE_VERSION, compareSemver } from '../version.js';
import { errorMessage, log } from '../log.js';
import { importLegacyEmbeddingIndex } from './vector-store.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { execWithBusyRetry, withWriteScope } from './busy.js';
import { tableExists } from './tables.js';
import { ensureMetaTable, getMeta, getSchemaVersion, setMeta, setSchemaVersion } from './meta.js';
import { MEMORIES_FTS_DDL, REQUIRED_SCHEMA_OBJECTS, ensureContinuityIndexes, ensureContinuityTables } from './continuity.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.js';

export function getCurrentSchemaVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

/** Thrown by {@link assertBinaryCompatible}; doctor uses it to pick the upgrade fix over a generic permissions fix. */
export class IncompatibleBinaryError extends Error {}

function assertMinBinary(minRequired: string | null | undefined): void {
  if (minRequired && compareSemver(minRequired, PACKAGE_VERSION) > 0) {
    throw new IncompatibleBinaryError(
      `hippo-memory: this database requires hippo-memory >= ${minRequired}, but the running binary is ${PACKAGE_VERSION}. ` +
      `Upgrade hippo-memory to open it; an older binary does not know this schema and could expose private rows or damage the store.`,
    );
  }
}

/** Refuse a store stamped for a newer binary. Fails closed: runMigrations creates meta first, so a failed read is a real error. */
export function assertBinaryCompatible(db: DatabaseSyncLike): void {
  assertMinBinary(getMeta(db, 'min_compatible_binary'));
}

const META_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['schema_version', String(CURRENT_SCHEMA_VERSION)],
  ['last_retrieval_ids', '[]'],
  ['last_trace_id', ''],
  ['total_remembered', '0'],
  ['total_recalled', '0'],
  ['total_forgotten', '0'],
  ['fts5_available', '0'],
];

// Names come from our own constants and match \w+, so inlining them as literals is safe.
const sqlList = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(', ');

/** The fast path's single probe: versions, the binary minimum, the FTS flag, and counts of the meta defaults and required objects. */
export const SCHEMA_PROBE_SQL = `SELECT
  (SELECT user_version FROM pragma_user_version) AS user_version,
  (SELECT value FROM meta WHERE key = 'schema_version') AS schema_version,
  (SELECT value FROM meta WHERE key = 'min_compatible_binary') AS min_binary,
  (SELECT value FROM meta WHERE key = 'fts5_available') AS fts5,
  (SELECT COUNT(*) FROM meta WHERE key IN (${sqlList(META_DEFAULTS.map(([key]) => key))})) AS meta_keys,
  (SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table', 'index') AND name IN (${sqlList(REQUIRED_SCHEMA_OBJECTS)})) AS objects,
  (SELECT MAX(id) FROM raw_archive) AS archive_top,
  (SELECT 1 FROM memories LIMIT 1) AS has_memories`;

interface SchemaProbe {
  user_version: number;
  schema_version: string | null;
  min_binary: string | null;
  fts5: string | null;
  meta_keys: number;
  objects: number;
  archive_top: number | null;
  has_memories: number | null;
}

/** What the probe of a current store read beyond the schema proof, so the same open need not read them again. */
export interface OpenFacts {
  /** The largest raw_archive id, 0 for an empty archive. */
  readonly archiveTop: number;
  readonly hasMemories: boolean;
}

/** The probe's facts when the store is current and whole, so the open can skip every DDL statement; else null. Runs the binary check either way. */
function currentStoreFacts(db: DatabaseSyncLike): OpenFacts | null {
  let probe: SchemaProbe | undefined;
  try {
    // SAFETY: the SELECT names exactly these eight columns and always returns one row.
    probe = db.prepare(SCHEMA_PROBE_SQL).get() as SchemaProbe | undefined;
  } catch (err) {
    // A store missing a table the probe reads is the slow path's job; anything else is a real error.
    if (err instanceof Error && /no such table: (meta|raw_archive|memories)\b/.test(err.message)) return null;
    throw err;
  }
  if (!probe) return null;
  assertMinBinary(probe.min_binary);
  const current = Number(probe.user_version) === CURRENT_SCHEMA_VERSION
    && Number(probe.schema_version) === CURRENT_SCHEMA_VERSION
    && Number(probe.meta_keys) === META_DEFAULTS.length
    && Number(probe.objects) === REQUIRED_SCHEMA_OBJECTS.length
    && probe.fts5 === '1';
  return current ? { archiveTop: Number(probe.archive_top ?? 0), hasMemories: probe.has_memories !== null } : null;
}

/** Brings the store to the current schema; returns the probe's facts when it was current already, null after any repair. */
export function runMigrations(db: DatabaseSyncLike, hippoRoot?: string, busyWaitMs?: number): OpenFacts | null {
  const facts = currentStoreFacts(db);
  if (!facts) migrateAndHeal(db, hippoRoot, busyWaitMs);
  if (hippoRoot) importLegacyVectors(db, hippoRoot);
  return facts;
}

function migrateAndHeal(db: DatabaseSyncLike, hippoRoot: string | undefined, busyWaitMs: number | undefined): void {
  ensureMetaTable(db);
  // Before anything writes, so a stale binary never repairs or migrates a store it does not understand.
  assertBinaryCompatible(db);

  let currentVersion = getSchemaVersion(db);
  if (currentVersion > 0) ensureContinuityTables(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    currentVersion = applyMigration(db, migration, hippoRoot, busyWaitMs);
  }
  healUserVersion(db, currentVersion, busyWaitMs);

  ensureContinuityIndexes(db);
  ensureMetaDefaults(db);
  ensureOptionalFts(db);
}

/** Applies one migration under the write lock and returns the version the store is now at. */
function applyMigration(
  db: DatabaseSyncLike,
  migration: (typeof MIGRATIONS)[number],
  hippoRoot: string | undefined,
  busyWaitMs: number | undefined,
): number {
  return withWriteScope(db, 'apply_migration', () => {
    // A newer binary may have migrated and raised the minimum while we waited for the lock.
    assertBinaryCompatible(db);
    // Re-read under the write lock: another process may have applied this
    // migration while we waited, and re-running one is not idempotent.
    const applied = getSchemaVersion(db);
    if (applied >= migration.version) return applied;
    migration.up(db, { hippoRoot });
    setSchemaVersion(db, migration.version);
    return migration.version;
  }, { busyWaitMs });
}

// The fast path requires user_version as well, and a store stamped only in meta would otherwise never reach it.
function healUserVersion(db: DatabaseSyncLike, version: number, busyWaitMs: number | undefined): void {
  // SAFETY: PRAGMA user_version returns one row with one integer column.
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const target = Math.max(0, Math.trunc(version));
  if (Number(row?.user_version ?? 0) < target) execWithBusyRetry(db, `PRAGMA user_version = ${target}`, busyWaitMs);
}

// A failed import leaves embeddings.json in place for the next open to retry; the store still opens.
function importLegacyVectors(db: DatabaseSyncLike, hippoRoot: string): void {
  try {
    importLegacyEmbeddingIndex(db, hippoRoot);
  } catch (err) {
    log.warn(`embeddings.json import failed; the next open retries it (${errorMessage(err)})`, { hippoRoot });
  }
}

function ensureMetaDefaults(db: DatabaseSyncLike): void {
  // Read-first: an already-current store has all 7 keys, so this is one
  // SELECT and zero writes instead of 7 no-op INSERT OR IGNOREs, each of
  // which takes a RESERVED lock even when nothing changes.
  const keys = META_DEFAULTS.map(([key]) => key);
  const present = new Set(
    (db
      .prepare(`SELECT key FROM meta WHERE key IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as Array<{ key: string }>)
      .map((r) => r.key),
  );
  if (present.size === META_DEFAULTS.length) return;

  const stmt = db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)`);
  for (const [key, value] of META_DEFAULTS) {
    if (!present.has(key)) stmt.run(key, value);
  }
}

function ensureOptionalFts(db: DatabaseSyncLike): void {
  let available = false;
  try {
    db.exec(MEMORIES_FTS_DDL);
    repairFtsDrift(db);
    available = true;
  } catch (err) {
    log.warn(`full-text index unavailable (${errorMessage(err)}); search falls back to slower LIKE matching`);
  }

  // Read-first: only write when the flag actually changed, so a healthy
  // store's open doesn't take a write lock for a same-value upsert.
  const flag = available ? '1' : '0';
  if (getMeta(db, 'fts5_available') !== flag) setMeta(db, 'fts5_available', flag);
}

/** Row counts of `memories` and its full-text index, which differ once the index drifts; null when either table is missing. */
export function ftsRowCounts(db: DatabaseSyncLike): { memories: number; fts: number } | null {
  if (!tableExists(db, 'memories_fts') || !tableExists(db, 'memories')) return null;
  // SAFETY: this get() result's shape matches the single aliased `c` column named in the SELECT.
  const memories = (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c?: number } | undefined)?.c ?? 0;
  // memories_fts_docsize is FTS5's cheaper one-row-per-document shadow table; fall back for a foreign-built index.
  const ftsTable = tableExists(db, 'memories_fts_docsize') ? 'memories_fts_docsize' : 'memories_fts';
  // SAFETY: this get() result's shape matches the single aliased `c` column named in the SELECT.
  const fts = (db.prepare(`SELECT COUNT(*) AS c FROM ${ftsTable}`).get() as { c?: number } | undefined)?.c ?? 0;
  return { memories: Number(memories), fts: Number(fts) };
}

/** Re-syncs `memories_fts` with `memories` when their counts differ and returns whether it did; sleep runs it because a fast open does not. */
export function repairFtsDrift(db: DatabaseSyncLike): boolean {
  const counts = ftsRowCounts(db);
  if (counts === null || counts.memories === counts.fts) return false;

  // NOT IN reads the UNINDEXED id column once, not once per memory; one NULL id would make NOT IN match nothing.
  db.exec(`
    INSERT INTO memories_fts(id, content, tags)
    SELECT m.id, m.content, m.tags_json
    FROM memories m
    WHERE m.id NOT IN (SELECT id FROM memories_fts WHERE id IS NOT NULL)
  `);

  db.exec(`
    DELETE FROM memories_fts
    WHERE id NOT IN (SELECT id FROM memories)
  `);
  return true;
}
