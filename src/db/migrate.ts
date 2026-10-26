import { PACKAGE_VERSION, compareSemver } from '../base/util/version.js';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { importLegacyEmbeddingIndex } from './vector-store.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { execWithBusyRetry, withWriteScope } from './busy.js';
import { tableExists } from './tables.js';
import { ensureMetaTable, getMeta, getSchemaVersion, setMeta, setSchemaVersion, META_KEY } from './meta.js';
import {
  MEMORIES_FTS_DDL,
  REQUIRED_SCHEMA_OBJECTS,
  ensureContinuityIndexes,
  ensureContinuityTables,
  ensureTrigramIndex,
  isFtsMissing,
  rebuildTrigramIndex,
} from './continuity.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.js';
import { placeholders } from './sql.js';
import { cachedStatement } from './statement-cache.js';
import { IncompatibleBinaryError } from '../base/errors/store-open.js';

export function getCurrentSchemaVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

export { IncompatibleBinaryError };

function assertMinBinary(minRequired: string | null | undefined): void {
  if (minRequired && compareSemver(minRequired, PACKAGE_VERSION) > 0) {
    throw new IncompatibleBinaryError(
      `hippo-memory: this database requires hippo-memory >= ` +
        `${minRequired}, but the running binary is ${PACKAGE_VERSION}. ` +
        `Upgrade hippo-memory to open it; an older binary does not know ` +
        `this schema and could expose private rows or damage the store.`,
    );
  }
}

// The probe's errors that mean a store the slow path must build: a table or column it reads is not there yet.
const PROBE_SLOW_PATH = /no such (table: (meta|raw_archive|memories)|column: mirror_cleaned_at)\b/;

/** Refuse a store stamped for a newer binary. Fails closed: runMigrations creates meta first, so a failed read is a
 * real error. */
export function assertBinaryCompatible(db: DatabaseSyncLike): void {
  assertMinBinary(getMeta(db, META_KEY.minCompatibleBinary));
}

const META_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  [META_KEY.schemaVersion, String(CURRENT_SCHEMA_VERSION)],
  [META_KEY.lastRetrievalIds, '[]'],
  [META_KEY.lastTraceId, ''],
  [META_KEY.totalRemembered, '0'],
  [META_KEY.totalRecalled, '0'],
  [META_KEY.totalForgotten, '0'],
  [META_KEY.fts5Available, '0'],
  [META_KEY.ftsInSync, '0'],
];

// Names come from our own constants and match \w+, so inlining them as literals is safe.
const sqlList = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(', ');

const REQUIRED_OBJECTS = sqlList(REQUIRED_SCHEMA_OBJECTS);
// The mirror rewrite marks sqlite/folder-files/due-mirrors.ts leaves; read here so an open with none due skips it.
const MIRRORS_DUE = `(SELECT 1 FROM meta WHERE key > 'mirror_due:' AND key < 'mirror_due;' LIMIT 1) AS mirrors_due`;
/** The fast path's single probe: versions, the binary minimum, the FTS flag, and counts of the meta defaults and
 * required objects. */
export const SCHEMA_PROBE_SQL = `SELECT
  (SELECT user_version FROM pragma_user_version) AS user_version,
  (SELECT value FROM meta WHERE key = '${META_KEY.schemaVersion}') AS schema_version,
  (SELECT value FROM meta WHERE key = '${META_KEY.minCompatibleBinary}') AS min_binary,
  (SELECT value FROM meta WHERE key = '${META_KEY.fts5Available}') AS fts5,
  (SELECT COUNT(*) FROM meta WHERE key IN (${sqlList(META_DEFAULTS.map(([key]) => key))})) AS meta_keys,
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger') AND name IN (${REQUIRED_OBJECTS})) AS objects,
  (SELECT 1 FROM raw_archive WHERE mirror_cleaned_at IS NULL LIMIT 1) AS archive_pending,
  (SELECT 1 FROM memories LIMIT 1) AS has_memories,
  ${MIRRORS_DUE}`;

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
interface SchemaProbe {
  user_version: number;
  schema_version: string | null;
  min_binary: string | null;
  fts5: string | null;
  meta_keys: number;
  objects: number;
  archive_pending: number | null;
  has_memories: number | null;
  mirrors_due: number | null;
}

/** What the probe of a current store read beyond the schema proof, so the same open need not read them again. */
export interface OpenFacts {
  /** Whether an archived row's mirror file is still to remove. */
  readonly archivePending: boolean;
  readonly hasMemories: boolean;
  /** Whether any markdown mirror is marked due for a rewrite. */
  readonly mirrorsDue: boolean;
}

/** The probe's facts when the store is current and whole, so the open can skip every DDL statement; else null. Runs the
 * binary check either way. */
function currentStoreFacts(db: DatabaseSyncLike): OpenFacts | null {
  let probe: SchemaProbe | undefined;
  try {
    probe = db.prepare(SCHEMA_PROBE_SQL).get() as SchemaProbe | undefined;
  } catch (err) {
    // A store missing a table the probe reads is the slow path's job; anything else is a real error.
    if (err instanceof Error && PROBE_SLOW_PATH.test(err.message)) return null;
    throw err;
  }
  if (!probe) return null;
  assertMinBinary(probe.min_binary);
  const current =
    Number(probe.user_version) === CURRENT_SCHEMA_VERSION &&
    Number(probe.schema_version) === CURRENT_SCHEMA_VERSION &&
    Number(probe.meta_keys) === META_DEFAULTS.length &&
    Number(probe.objects) === REQUIRED_SCHEMA_OBJECTS.length &&
    probe.fts5 === '1';
  return current ? factsOf(probe) : null;
}

function factsOf(row: Pick<SchemaProbe, 'archive_pending' | 'has_memories' | 'mirrors_due'>): OpenFacts {
  return {
    archivePending: row.archive_pending !== null,
    hasMemories: row.has_memories !== null,
    mirrorsDue: row.mirrors_due !== null,
  };
}

const SETTLED_CHECK_SQL = `SELECT
  (SELECT user_version FROM pragma_user_version) AS user_version,
  (SELECT value FROM meta WHERE key = '${META_KEY.schemaVersion}') AS schema_version,
  (SELECT value FROM meta WHERE key = '${META_KEY.minCompatibleBinary}') AS min_binary,
  (SELECT 1 FROM raw_archive WHERE mirror_cleaned_at IS NULL LIMIT 1) AS archive_pending,
  (SELECT 1 FROM memories LIMIT 1) AS has_memories,
  ${MIRRORS_DUE}`;

/** For a store this process has proven: one cheap statement returns the open's facts when both schema stamps still name
 * the current schema, else null; it refuses when another binary has since raised the minimum. */
export function settledStoreFacts(db: DatabaseSyncLike): OpenFacts | null {
  // SAFETY: SETTLED_CHECK_SQL reads only scalar subqueries, so it always answers one row.
  const row = cachedStatement(db, SETTLED_CHECK_SQL).get() as {
    user_version: number;
    schema_version: string | null;
    min_binary: string | null;
    archive_pending: number | null;
    has_memories: number | null;
    mirrors_due: number | null;
  };
  assertMinBinary(row.min_binary);
  const current =
    Number(row.user_version) === CURRENT_SCHEMA_VERSION && Number(row.schema_version) === CURRENT_SCHEMA_VERSION;
  return current ? factsOf(row) : null;
}

/** Brings the store to the current schema; returns the probe's facts when it was current already, null after any
 * repair. */
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
  return withWriteScope(
    db,
    'apply_migration',
    () => {
      // A newer binary may have migrated and raised the minimum while we waited for the lock.
      assertBinaryCompatible(db);
      // Re-read under the write lock: another process may have applied this migration while we waited, and re-running
      // one is not idempotent.
      const applied = getSchemaVersion(db);
      if (applied >= migration.version) return applied;
      migration.up(db, { hippoRoot });
      setSchemaVersion(db, migration.version);
      return migration.version;
    },
    { busyWaitMs },
  );
}

// The fast path requires user_version as well, and a store stamped only in meta would otherwise never reach it.
function healUserVersion(db: DatabaseSyncLike, version: number, busyWaitMs: number | undefined): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const target = Math.max(0, Math.trunc(version));
  if (Number(row?.user_version ?? 0) < target) execWithBusyRetry(db, `PRAGMA user_version = ${target}`, busyWaitMs);
}

// A failed import leaves embeddings.json in place for the next open to retry; the store still opens.
export function importLegacyVectors(db: DatabaseSyncLike, hippoRoot: string): void {
  try {
    importLegacyEmbeddingIndex(db, hippoRoot);
  } catch (err) {
    log.warn(`embeddings.json import failed; the next open retries it (${errorMessage(err)})`, {
      hippoRoot,
      ...errorFields(err),
    });
  }
}

function ensureMetaDefaults(db: DatabaseSyncLike): void {
  // Read-first: an already-current store has all 7 keys, so this is one SELECT and zero writes instead of 7 no-op
  // INSERT OR IGNOREs, each of which takes a RESERVED lock even when nothing changes.
  const keys = META_DEFAULTS.map(([key]) => key);
  // SAFETY: meta.key is TEXT NOT NULL.
  const present = new Set(
    (
      db.prepare(`SELECT key FROM meta WHERE key IN (${placeholders(keys.length)})`).all(...keys) as Array<{
        key: string;
      }>
    ).map((r) => r.key),
  );
  if (present.size === META_DEFAULTS.length) return;

  const stmt = db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)`);
  for (const [key, value] of META_DEFAULTS) {
    if (!present.has(key)) stmt.run(key, value);
  }
}

function ensureOptionalFts(db: DatabaseSyncLike): void {
  try {
    db.exec(MEMORIES_FTS_DDL);
    ensureTrigramIndex(db);
    repairFtsDrift(db);
  } catch (err) {
    // A busy or locked open says nothing about fts5, so only a missing module may flip the flag.
    if (!isFtsMissing(errorMessage(err))) {
      log.warn(`full-text index not set up this open (${errorMessage(err)}); the next open retries`, errorFields(err));
      return;
    }
    log.warn(
      `full-text index unavailable (${errorMessage(err)}); search falls back to slower LIKE matching`,
      errorFields(err),
    );
    writeFtsFlag(db, '0');
    return;
  }
  writeFtsFlag(db, '1');
}

// Read-first: only write when the flag actually changed, so a healthy store's open takes no write lock.
function writeFtsFlag(db: DatabaseSyncLike, flag: '0' | '1'): void {
  if (getMeta(db, META_KEY.fts5Available) !== flag) setMeta(db, META_KEY.fts5Available, flag);
}

/** Row counts of `memories` and its full-text index, which differ once the index drifts; null when either table is
 * missing. */
export function ftsRowCounts(db: DatabaseSyncLike): { memories: number; fts: number } | null {
  if (!tableExists(db, 'memories_fts') || !tableExists(db, 'memories')) return null;
  const memories = (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c?: number } | undefined)?.c ?? 0;
  // memories_fts_docsize is FTS5's cheaper one-row-per-document shadow table; fall back for a foreign-built index.
  const ftsTable = tableExists(db, 'memories_fts_docsize') ? 'memories_fts_docsize' : 'memories_fts';
  const fts = (db.prepare(`SELECT COUNT(*) AS c FROM ${ftsTable}`).get() as { c?: number } | undefined)?.c ?? 0;
  return { memories: Number(memories), fts: Number(fts) };
}

/** Whether the last real count found `memories_fts` level with `memories` and no write since has failed to index a row;
 * a read trusts this instead of counting both tables. */
export function isFtsInSync(db: DatabaseSyncLike): boolean {
  return getMeta(db, META_KEY.ftsInSync, '0') === '1';
}

/** Records what a real count found (or what a failed index write now makes false); read-first so a steady store takes
 * no write lock. */
export function setFtsInSync(db: DatabaseSyncLike, inSync: boolean): void {
  const flag = inSync ? '1' : '0';
  if (getMeta(db, META_KEY.ftsInSync) !== flag) setMeta(db, META_KEY.ftsInSync, flag);
}

/** Re-syncs `memories_fts` with `memories` when their counts differ and returns whether it did; sleep runs it because a
 * fast open does not. Leaves the in-sync flag true. */
export function repairFtsDrift(db: DatabaseSyncLike): boolean {
  repairTrigramDrift(db);
  const counts = ftsRowCounts(db);
  if (counts === null) return false;
  if (counts.memories === counts.fts) {
    setFtsInSync(db, true);
    return false;
  }

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
  setFtsInSync(db, true);
  return true;
}

// Triggers keep the substring index level, so a count that differs means a store edited with them off: rebuild it.
function repairTrigramDrift(db: DatabaseSyncLike): void {
  if (!tableExists(db, 'memories_trigram_docsize')) return;
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM memories) AS memories, (SELECT COUNT(*) FROM memories_trigram_docsize) AS indexed`,
    )
    .get() as { memories: number; indexed: number };
  if (Number(row.memories) !== Number(row.indexed)) rebuildTrigramIndex(db);
}
