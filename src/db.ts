import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { createPhysicsTable } from './physics-state.js';

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

const CURRENT_SCHEMA_VERSION = 10;

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
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          summary TEXT NOT NULL,
          next_step TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_task_snapshots_status_updated
        ON task_snapshots(status, updated_at DESC, id DESC);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_a_id TEXT NOT NULL,
          memory_b_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          score REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(memory_a_id, memory_b_id)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_conflicts_status_updated
        ON memory_conflicts(status, updated_at DESC, id DESC);
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      if (!tableHasColumn(db, 'task_snapshots', 'session_id')) {
        db.exec(`ALTER TABLE task_snapshots ADD COLUMN session_id TEXT`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          task TEXT,
          event_type TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_events_session_created
        ON session_events(session_id, created_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_session_events_task_created
        ON session_events(task, created_at DESC, id DESC);
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          repo_root TEXT,
          task_id TEXT,
          summary TEXT NOT NULL,
          next_action TEXT,
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_handoffs_session
        ON session_handoffs(session_id, created_at DESC);
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS working_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          importance REAL NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_working_memory_scope
        ON working_memory(scope, importance DESC, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_working_memory_session
        ON working_memory(session_id, created_at DESC);
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'outcome_positive')) {
        db.exec(`ALTER TABLE memories ADD COLUMN outcome_positive INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'outcome_negative')) {
        db.exec(`ALTER TABLE memories ADD COLUMN outcome_negative INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 8,
    up: (db) => {
      createPhysicsTable(db);
    },
  },
  {
    version: 9,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'parents_json')) {
        db.exec(`ALTER TABLE memories ADD COLUMN parents_json TEXT NOT NULL DEFAULT '[]'`);
      }
      if (!tableHasColumn(db, 'memories', 'starred')) {
        db.exec(`ALTER TABLE memories ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 10,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'trace_outcome')) {
        db.exec(`ALTER TABLE memories ADD COLUMN trace_outcome TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'source_session_id')) {
        db.exec(`ALTER TABLE memories ADD COLUMN source_session_id TEXT`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_source_session_id
        ON memories(source_session_id) WHERE source_session_id IS NOT NULL
      `);
    },
  },
];

function tableHasColumn(db: DatabaseSyncLike, tableName: string, columnName: string): boolean {
  if (!/^[a-z_]+$/i.test(tableName)) throw new Error(`Invalid table name: ${tableName}`);
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

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
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA wal_autocheckpoint = 100');
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
