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

const CURRENT_SCHEMA_VERSION = 18;

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
  {
    version: 11,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'valid_from')) {
        db.exec(`ALTER TABLE memories ADD COLUMN valid_from TEXT`);
        db.exec(`UPDATE memories SET valid_from = created WHERE valid_from IS NULL`);
      }
      if (!tableHasColumn(db, 'memories', 'superseded_by')) {
        db.exec(`ALTER TABLE memories ADD COLUMN superseded_by TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL`);
    },
  },
  {
    version: 12,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'extracted_from')) {
        db.exec(`ALTER TABLE memories ADD COLUMN extracted_from TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_extracted_from ON memories(extracted_from) WHERE extracted_from IS NOT NULL`);
    },
  },
  {
    version: 13,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'dag_level')) {
        db.exec(`ALTER TABLE memories ADD COLUMN dag_level INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'dag_parent_id')) {
        db.exec(`ALTER TABLE memories ADD COLUMN dag_parent_id TEXT`);
      }
      db.exec(`UPDATE memories SET dag_level = 1 WHERE extracted_from IS NOT NULL AND dag_level = 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_dag_parent ON memories(dag_parent_id) WHERE dag_parent_id IS NOT NULL`);
    },
  },
  {
    version: 14,
    up: (db) => {
      // A3 provenance envelope: kind, scope, owner, artifact_ref.
      // SQLite ALTER TABLE ADD COLUMN cannot add CHECK; CHECK enforcement lives
      // in INSERT/UPDATE triggers added later in this migration.
      if (!tableHasColumn(db, 'memories', 'kind')) {
        db.exec(`ALTER TABLE memories ADD COLUMN kind TEXT DEFAULT 'distilled'`);
      }
      if (!tableHasColumn(db, 'memories', 'scope')) {
        db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL`);
      }
      if (!tableHasColumn(db, 'memories', 'owner')) {
        db.exec(`ALTER TABLE memories ADD COLUMN owner TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'artifact_ref')) {
        db.exec(`ALTER TABLE memories ADD COLUMN artifact_ref TEXT`);
      }
      // Backfill kind for any rows where it's NULL (pre-migration data).
      db.exec(`UPDATE memories SET kind = 'superseded' WHERE kind IS NULL AND superseded_by IS NOT NULL`);
      db.exec(`UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`);
      // raw_archive: legitimate path for kind='raw' removal (used by archiveRawMemory).
      db.exec(`
        CREATE TABLE IF NOT EXISTS raw_archive (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          archived_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          archived_by TEXT,
          payload_json TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_archive_memory_id ON raw_archive(memory_id)`);
      // Append-only invariant: kind='raw' rows cannot be deleted directly.
      // Use raw_archive flow: archive-then-update-then-delete (see src/raw-archive.ts).
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_memories_raw_append_only
        BEFORE DELETE ON memories
        WHEN OLD.kind = 'raw'
        BEGIN
          SELECT RAISE(ABORT, 'raw is append-only');
        END
      `);
      // CHECK substitute: ALTER TABLE cannot add CHECK, so enforce kind allowed-set
      // via INSERT/UPDATE triggers.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_memories_kind_check_insert
        BEFORE INSERT ON memories
        WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived');
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_memories_kind_check_update
        BEFORE UPDATE ON memories
        WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived');
        END
      `);
    },
  },
  {
    version: 15,
    up: (db) => {
      // A3 hardening (post-review): close the NULL-kind bypass and add raw_archive
      // dedup safety. Both findings landed in /review on commits 41b1f4d..6456e7d.
      //
      // (1) Original v14 triggers used `WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN (...)`.
      //     A direct INSERT/UPDATE setting kind=NULL bypassed the CHECK substitute. Replace
      //     with `WHEN NEW.kind IS NULL OR NEW.kind NOT IN (...)` so NULL is rejected too.
      // (2) Add UNIQUE(memory_id, archived_at) to raw_archive so re-archiving the same id
      //     in the same instant cannot produce ambiguous audit rows. Per-id history is still
      //     allowed (different timestamps).
      db.exec(`DROP TRIGGER IF EXISTS trg_memories_kind_check_insert`);
      db.exec(`DROP TRIGGER IF EXISTS trg_memories_kind_check_update`);
      db.exec(`
        CREATE TRIGGER trg_memories_kind_check_insert
        BEFORE INSERT ON memories
        WHEN NEW.kind IS NULL OR NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived (not null)');
        END
      `);
      db.exec(`
        CREATE TRIGGER trg_memories_kind_check_update
        BEFORE UPDATE ON memories
        WHEN NEW.kind IS NULL OR NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived (not null)');
        END
      `);
      // Defensive: any rows that somehow have NULL kind get fixed (shouldn't exist post-v14
      // backfill, but cheap insurance).
      db.exec(`UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`);
      // raw_archive uniqueness. SQLite cannot ADD CONSTRAINT, but a partial unique index
      // on (memory_id, archived_at) is equivalent for INSERT-time enforcement.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_archive_id_at
        ON raw_archive(memory_id, archived_at)
      `);
    },
  },
  {
    version: 16,
    up: (db) => {
      // A5 stub auth: add tenant_id to all data tables. Single-tenant per deployment;
      // multi-tenant enforcement deferred to v2 (full A5). The columns are needed now
      // so future B-track tables don't have to backfill.
      if (!tableHasColumn(db, 'memories', 'tenant_id')) {
        db.exec(`ALTER TABLE memories ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'working_memory', 'tenant_id')) {
        db.exec(`ALTER TABLE working_memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'consolidation_runs', 'tenant_id')) {
        db.exec(`ALTER TABLE consolidation_runs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'task_snapshots', 'tenant_id')) {
        db.exec(`ALTER TABLE task_snapshots ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'memory_conflicts', 'tenant_id')) {
        db.exec(`ALTER TABLE memory_conflicts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      // Composite indexes for recall hot paths. Leading column is tenant_id so
      // single-tenant lookups are O(log n).
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_tenant_created ON memories(tenant_id, created)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_working_memory_tenant ON working_memory(tenant_id, importance DESC, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_consolidation_runs_tenant_ts ON consolidation_runs(tenant_id, timestamp DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_status ON task_snapshots(tenant_id, status, updated_at DESC)`);
      // A5 stub auth: api_keys (scrypt-hashed; plaintext returned to caller exactly once)
      // and audit_log (append-only mutation trail). Both carry tenant_id from day 1 so
      // future multi-tenant enforcement is a config flip, not a re-migration.
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_id TEXT UNIQUE NOT NULL,
          key_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          label TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_active
        ON api_keys(tenant_id) WHERE revoked_at IS NULL
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          actor TEXT NOT NULL,
          op TEXT NOT NULL,
          target_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_ts ON audit_log(tenant_id, ts DESC)`);
    },
  },
  {
    version: 17,
    up: (db) => {
      // E1.3 Slack ingestion: idempotency log, per-channel backfill cursors, DLQ.
      // See docs/plans/2026-04-29-e1.3-slack-ingestion.md.
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_event_log (
          event_id TEXT PRIMARY KEY,
          ingested_at TEXT NOT NULL,
          memory_id TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_slack_event_log_memory ON slack_event_log(memory_id) WHERE memory_id IS NOT NULL`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_cursors (
          tenant_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          latest_ts TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, channel_id)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_dlq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          error TEXT NOT NULL,
          received_at TEXT NOT NULL,
          retried_at TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_slack_dlq_tenant_received ON slack_dlq(tenant_id, received_at)`);
      // Multi-tenant routing seam (review patch #6). Empty by default — single-
      // tenant deployments resolve via HIPPO_TENANT fallback. Multi-workspace
      // deployments populate this table to map team_id → tenant_id.
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_workspaces (
          team_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 18,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goal_stack (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          goal_name TEXT NOT NULL,
          level INTEGER NOT NULL DEFAULT 0
            CHECK (level BETWEEN 0 AND 2),
          parent_goal_id TEXT REFERENCES goal_stack(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('active','suspended','completed')),
          success_condition TEXT,
          retrieval_policy_id TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          outcome_score REAL
            CHECK (outcome_score IS NULL OR (outcome_score >= 0 AND outcome_score <= 1))
        );

        CREATE INDEX IF NOT EXISTS idx_goal_stack_tenant_session_status
          ON goal_stack(tenant_id, session_id, status, created_at);

        CREATE TABLE IF NOT EXISTS retrieval_policy (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          policy_type TEXT NOT NULL CHECK (policy_type IN
            ('schema-fit-biased','error-prioritized','recency-first','hybrid')),
          weight_schema_fit REAL NOT NULL DEFAULT 1.0,
          weight_recency REAL NOT NULL DEFAULT 1.0,
          weight_outcome REAL NOT NULL DEFAULT 1.0,
          error_priority REAL NOT NULL DEFAULT 1.0
        );

        CREATE INDEX IF NOT EXISTS idx_retrieval_policy_goal
          ON retrieval_policy(goal_id);

        CREATE TABLE IF NOT EXISTS goal_recall_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          session_id TEXT NOT NULL,
          recalled_at TEXT NOT NULL,
          score REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_goal_recall_log_goal
          ON goal_recall_log(goal_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_goal_recall_log_memory_goal
          ON goal_recall_log(memory_id, goal_id);
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
  const memCount = (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c?: number } | undefined)?.c ?? 0;
  const ftsCount = (db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get() as { c?: number } | undefined)?.c ?? 0;
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
