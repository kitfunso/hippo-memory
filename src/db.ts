import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

interface StatementSyncLike {
  run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes?: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

const CURRENT_SCHEMA_VERSION = 1;

type Migration = {
  version: number;
  up: (db: DatabaseSyncLike) => void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          created TEXT NOT NULL,
          last_retrieved TEXT NOT NULL,
          retrieval_count INTEGER NOT NULL,
          strength REAL NOT NULL,
          half_life_days REAL NOT NULL,
          layer TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          emotional_valence TEXT NOT NULL,
          schema_fit REAL NOT NULL,
          source TEXT NOT NULL,
          outcome_score REAL,
          conflicts_with_json TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          confidence TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_memories_layer_created ON memories(layer, created);
        CREATE INDEX IF NOT EXISTS idx_memories_last_retrieved ON memories(last_retrieved);

        CREATE TABLE IF NOT EXISTS consolidation_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          decayed INTEGER NOT NULL,
          merged INTEGER NOT NULL,
          removed INTEGER NOT NULL
        );
      `);
    },
  },
];

export function getHippoDbPath(hippoRoot: string): string {
  return path.join(hippoRoot, 'hippo.db');
}

export function getCurrentSchemaVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

export function openHippoDb(hippoRoot: string): DatabaseSyncLike {
  fs.mkdirSync(hippoRoot, { recursive: true });
  const db = new DatabaseSync(getHippoDbPath(hippoRoot));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Best effort only.
    }
    throw error;
  }
}

function runMigrations(db: DatabaseSyncLike): void {
  ensureMetaTable(db);

  let currentVersion = getSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    db.exec('BEGIN');
    try {
      migration.up(db);
      setSchemaVersion(db, migration.version);
      db.exec('COMMIT');
      currentVersion = migration.version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  ensureMetaDefaults(db);
  ensureOptionalFts(db);
}

function ensureMetaTable(db: DatabaseSyncLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getSchemaVersion(db: DatabaseSyncLike): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: string } | undefined;
  const version = Number(row?.value ?? 0);
  return Number.isFinite(version) ? version : 0;
}

function setSchemaVersion(db: DatabaseSyncLike, version: number): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(version));
  db.exec(`PRAGMA user_version = ${Math.max(0, Math.trunc(version))}`);
}

function ensureMetaDefaults(db: DatabaseSyncLike): void {
  const defaults: Array<[string, string]> = [
    ['schema_version', String(CURRENT_SCHEMA_VERSION)],
    ['last_retrieval_ids', '[]'],
    ['total_remembered', '0'],
    ['total_recalled', '0'],
    ['total_forgotten', '0'],
    ['fts5_available', '0'],
  ];

  const stmt = db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)`);
  for (const [key, value] of defaults) {
    stmt.run(key, value);
  }
}

function ensureOptionalFts(db: DatabaseSyncLike): void {
  let available = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tags)`);
    backfillFtsIndex(db);
    available = true;
  } catch {
    available = false;
  }

  db.prepare(`INSERT INTO meta(key, value) VALUES('fts5_available', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(available ? '1' : '0');
}

function backfillFtsIndex(db: DatabaseSyncLike): void {
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

export function closeHippoDb(db: DatabaseSyncLike): void {
  db.close();
}

export function getMeta(db: DatabaseSyncLike, key: string, fallback = ''): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
  return row?.value ?? fallback;
}

export function setMeta(db: DatabaseSyncLike, key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

export function isFtsAvailable(db: DatabaseSyncLike): boolean {
  return getMeta(db, 'fts5_available', '0') === '1';
}

export function pruneConsolidationRuns(db: DatabaseSyncLike, keep = 50): void {
  db.prepare(`
    DELETE FROM consolidation_runs
    WHERE id NOT IN (
      SELECT id FROM consolidation_runs
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    )
  `).run(keep);
}
