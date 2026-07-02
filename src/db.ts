import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { createPhysicsTable } from './physics-state.js';
import { cleanupArchivedMirrors } from './raw-archive-mirror-cleanup.js';
import { PACKAGE_VERSION, compareSemver } from './version.js';
import { deriveOriginProject, originFromSource, isGlobalStoreRoot } from './project-identity.js';

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

const CURRENT_SCHEMA_VERSION = 39;

/**
 * Context passed to migrations that need to know WHERE the store lives.
 * hippoRoot is the store directory (e.g. `<project>/.hippo`); undefined only
 * for callers that open a DB without a filesystem store notion (none today).
 */
type MigrationContext = { hippoRoot?: string };

type Migration = {
  version: number;
  up: (db: DatabaseSyncLike, ctx?: MigrationContext) => void;
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
          weight_schema_fit REAL NOT NULL DEFAULT 1.0
            CHECK (weight_schema_fit >= 0 AND weight_schema_fit <= 100),
          weight_recency REAL NOT NULL DEFAULT 1.0
            CHECK (weight_recency >= 0 AND weight_recency <= 100),
          weight_outcome REAL NOT NULL DEFAULT 1.0
            CHECK (weight_outcome >= 0 AND weight_outcome <= 100),
          error_priority REAL NOT NULL DEFAULT 1.0
            CHECK (error_priority >= 0 AND error_priority <= 100)
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
  {
    version: 19,
    up: (db) => {
      // v0.39 commit 3 (Slack hardening): widen slack_dlq with bucketing,
      // retry tracking, and the signature/timestamp pair that lets `hippo
      // slack dlq replay` re-verify before re-running ingest. ALTER ADD
      // COLUMN with DEFAULT is non-destructive — legacy rows take the
      // default values. Idempotent via tableHasColumn().
      if (!tableHasColumn(db, 'slack_dlq', 'team_id')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN team_id TEXT`);
      }
      if (!tableHasColumn(db, 'slack_dlq', 'bucket')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN bucket TEXT NOT NULL DEFAULT 'parse_error'`);
        // SQLite ALTER TABLE cannot add CHECK; bucket value enforcement is app-level.
      }
      if (!tableHasColumn(db, 'slack_dlq', 'retry_count')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'slack_dlq', 'signature')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN signature TEXT`);
      }
      if (!tableHasColumn(db, 'slack_dlq', 'slack_timestamp')) {
        db.exec(`ALTER TABLE slack_dlq ADD COLUMN slack_timestamp TEXT`);
      }
    },
  },
  {
    version: 20,
    up: (db) => {
      // v0.39 commit 4 (GDPR Path A backfill): redact every existing
      // raw_archive.payload_json so historical archives match the new
      // metadata-only contract from src/raw-archive.ts. Read each row, parse
      // the existing JSON to extract tenant_id and kind (best effort), then
      // UPDATE with the redacted shape. Rows with unparseable legacy JSON get
      // redacted with tenant_id='unknown', kind='unknown'. The audit_log
      // remains the compliance record.
      const rows = db
        .prepare(`SELECT id, archived_at, reason, payload_json FROM raw_archive`)
        .all() as Array<{
        id: number;
        archived_at: string;
        reason: string;
        payload_json: string;
      }>;
      const update = db.prepare(`UPDATE raw_archive SET payload_json = ? WHERE id = ?`);
      for (const row of rows) {
        let tenant = 'unknown';
        let kind = 'unknown';
        try {
          const parsed = JSON.parse(row.payload_json) as {
            tenant_id?: string;
            kind?: string;
          };
          tenant = parsed.tenant_id ?? 'unknown';
          kind = parsed.kind ?? 'unknown';
        } catch {
          // Unparseable legacy payload — redact with unknowns.
        }
        const redacted = JSON.stringify({
          redacted: true,
          archived_at: row.archived_at,
          tenant_id: tenant,
          kind,
          reason: row.reason,
          migration: 'v20_redact',
        });
        update.run(redacted, row.id);
      }
    },
  },
  {
    version: 21,
    up: (db) => {
      // v0.39 codex round 3: per-row mirror cleanup tracking. Replaces the
      // global gdpr_v20_mirror_cleanup meta gate (which made the reaper
      // one-shot and silently swallowed failed unlinks). With this column the
      // reaper processes only rows WHERE mirror_cleaned_at IS NULL, sets the
      // timestamp on success, and leaves it NULL on any unlink failure so the
      // next openHippoDb retries automatically.
      if (!tableHasColumn(db, 'raw_archive', 'mirror_cleaned_at')) {
        db.exec(`ALTER TABLE raw_archive ADD COLUMN mirror_cleaned_at TEXT`);
      }
    },
  },
  {
    version: 22,
    up: (db) => {
      // Tenant-isolation gap on continuity tables (codex review 2026-05-02).
      // session_events and session_handoffs predate the v16 tenant migration
      // and were never added to it, so the v0.40.0 provenance gate work
      // exposed a real cross-tenant leak when continuity primitives are used.
      // Adds tenant_id (NOT NULL DEFAULT 'default') with smart backfill from
      // task_snapshots.session_id when unambiguous, plus an optional scope
      // column so a private-channel-derived handoff can default-deny via the
      // same rule recall already enforces.
      //
      // Self-heal partial-init stores: re-run the v4/v5 CREATE TABLE IF NOT
      // EXISTS bodies before ALTERing. A silent skip would otherwise stamp
      // schema_version=22 on a DB missing the underlying tables, leaving
      // them permanently absent.
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
      `);
      if (!tableHasColumn(db, 'session_events', 'tenant_id')) {
        db.exec(`ALTER TABLE session_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'session_events', 'scope')) {
        db.exec(`ALTER TABLE session_events ADD COLUMN scope TEXT`);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'tenant_id')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'scope')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN scope TEXT`);
      }

      // Smart backfill: rows whose session_id maps to exactly one tenant in
      // task_snapshots inherit that tenant. Ambiguous or unmapped rows stay
      // at the column default ('default'). Conservative: never crosses
      // tenant boundaries on guesses. The COUNT(DISTINCT) gate is the load-
      // bearing check; without it, rows with multiple tenants under the same
      // session_id would silently pick whichever group came first.
      db.exec(`
        UPDATE session_events
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_events.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_events.session_id) = 1
      `);
      db.exec(`
        UPDATE session_handoffs
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_handoffs.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_handoffs.session_id) = 1
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_tenant_session ON session_events(tenant_id, session_id, created_at DESC, id DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_session ON session_handoffs(tenant_id, session_id, created_at DESC)`);
    },
  },
  {
    version: 23,
    up: (db) => {
      // task_snapshots: add scope so all three continuity tables carry it.
      // Self-heal partial-init stores via CREATE TABLE IF NOT EXISTS (the v22
      // session_events / session_handoffs healing is upstream).
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          summary TEXT NOT NULL,
          next_step TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          session_id TEXT,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      if (!tableHasColumn(db, 'task_snapshots', 'scope')) {
        db.exec(`ALTER TABLE task_snapshots ADD COLUMN scope TEXT`);
      }
      // Quarantine policy (codex round 1 P1): pre-existing continuity rows
      // with NULL scope cannot be safely classified as public after the fact.
      // Mark them 'unknown:legacy' so the api.recall + cmdRecall default-deny
      // filter excludes them for no-scope callers. Fresh rows from new
      // writers carry NULL when scope is unspecified (legitimate non-Slack
      // writes); the 'unknown:legacy' marker is a v23-only one-shot for
      // pre-upgrade rows.
      //
      // Run UPDATEs only on tables that exist (some test paths and edge stores
      // skip v22's table healing). The UPDATEs are themselves idempotent via
      // the WHERE scope IS NULL clause, so re-running is a no-op.
      if (tableExists(db, 'task_snapshots')) {
        db.exec(`UPDATE task_snapshots SET scope = 'unknown:legacy' WHERE scope IS NULL`);
      }
      if (tableExists(db, 'session_events')) {
        db.exec(`UPDATE session_events SET scope = 'unknown:legacy' WHERE scope IS NULL`);
      }
      if (tableExists(db, 'session_handoffs')) {
        db.exec(`UPDATE session_handoffs SET scope = 'unknown:legacy' WHERE scope IS NULL`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_scope ON task_snapshots(tenant_id, scope, status)`);
    },
  },
  {
    version: 24,
    up: (db) => {
      // v1.3.0 GitHub connector schema (codex round 1, 2026-05-04).
      // Six tables + a min_compatible_binary meta row for rollback safety.

      db.exec(`
        CREATE TABLE IF NOT EXISTS github_event_log (
          idempotency_key TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          ingested_at TEXT NOT NULL,
          memory_id TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_memory ON github_event_log(memory_id) WHERE memory_id IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_delivery ON github_event_log(delivery_id)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS github_cursors (
          tenant_id TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          issues_hwm TEXT,
          issue_comments_hwm TEXT,
          pr_review_comments_hwm TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, repo_full_name)
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS github_dlq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          error TEXT NOT NULL,
          event_name TEXT,
          delivery_id TEXT,
          signature TEXT,
          installation_id TEXT,
          repo_full_name TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          received_at TEXT NOT NULL,
          retried_at TEXT,
          bucket TEXT NOT NULL DEFAULT 'parse_error'
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_dlq_tenant_received ON github_dlq(tenant_id, received_at)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS github_installations (
          installation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        )
      `);

      // PAT-mode multi-tenant routing (codex P0 #4). Maps repo_full_name to
      // tenant when the webhook envelope has no `installation` field. Composite
      // PK so the same repo can intentionally be visible to multiple tenants
      // (e.g., shared tooling accounts) — collision is on (repo, tenant) pair.
      db.exec(`
        CREATE TABLE IF NOT EXISTS github_repositories (
          repo_full_name TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (repo_full_name, tenant_id)
        )
      `);

      // Rollback-safety guard (codex P0 #2). Any binary < 1.2.1 lacks the
      // generic *:private:* default-deny and would leak github:private:* rows
      // if it opened this DB. The startup guard in v1.2.1+ refuses to open a
      // DB whose min_compatible_binary is newer than its own version.
      db.prepare(`INSERT INTO meta(key, value) VALUES('min_compatible_binary', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('1.2.1');
    },
  },
  {
    version: 25,
    up: (db) => {
      // v1.5.0 DAG-aware recall — cache summary metadata so the assembler can
      // reason about scope without re-walking the DAG. Three additive,
      // optional columns. No min_compatible_binary bump: these columns are
      // pure metadata; older binaries opening this DB will see them as NULL
      // / 0 and behave as before. See docs/plans/2026-05-05-dag-recall.md
      // Task 1.
      if (!tableHasColumn(db, 'memories', 'descendant_count')) {
        db.exec(`ALTER TABLE memories ADD COLUMN descendant_count INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'earliest_at')) {
        db.exec(`ALTER TABLE memories ADD COLUMN earliest_at TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'latest_at')) {
        db.exec(`ALTER TABLE memories ADD COLUMN latest_at TEXT`);
      }
      // Backfill descendant_count for existing level-2 summary rows. Use
      // dag_parent_id pointing at the summary id. Level-3 (entity profiles)
      // not built today; their descendant_count stays at default 0.
      db.exec(`
        UPDATE memories
           SET descendant_count = (
             SELECT COUNT(*) FROM memories AS c WHERE c.dag_parent_id = memories.id
           )
         WHERE dag_level >= 2
           AND descendant_count = 0
      `);
      // Backfill earliest_at / latest_at from child created timestamps for
      // existing summaries. Children of a level-2 summary are level-1 facts.
      db.exec(`
        UPDATE memories
           SET earliest_at = (
             SELECT MIN(c.created) FROM memories AS c WHERE c.dag_parent_id = memories.id
           ),
               latest_at = (
             SELECT MAX(c.created) FROM memories AS c WHERE c.dag_parent_id = memories.id
           )
         WHERE dag_level >= 2
           AND earliest_at IS NULL
      `);
    },
  },
  {
    version: 26,
    up: (db) => {
      // v1.12.0 A5 v2 sub-1: add role column to api_keys for the admin/member
      // distinction that gates /v1/sleep. Additive — existing keys backfill to
      // 'admin' via DEFAULT (single-tenant operator = admin by definition).
      // No min_compatible_binary bump: old binaries (v1.11.x) ignore the
      // column on SELECTs that don't name it; new binaries on old data run
      // this migration at openHippoDb time before any createApiKey call.
      //
      // v1.12.7 defensive: also guard on tableExists. If a DB landed in the
      // partial-v16-state (api_keys table missing despite schema_version >= 16),
      // running ALTER TABLE here would crash and block all later migrations.
      // The v27 heal below recreates api_keys with the role column already
      // present, so this ALTER becomes a no-op anyway for that path. Defense
      // in depth: guard so v26 never crashes on the partial-apply state.
      if (tableExists(db, 'api_keys') && !tableHasColumn(db, 'api_keys', 'role')) {
        db.exec(`ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      }
    },
  },
  {
    version: 27,
    up: (db) => {
      // v1.12.7 self-heal — re-assert the v16 schema (api_keys + audit_log).
      //
      // Surfaced 2026-05-24 on Keith's ~/.hippo/hippo.db: schema_version
      // recorded as 25 but api_keys and audit_log tables were missing from
      // migration v16. Root cause unknown — the migration runner has wrapped
      // each migration in BEGIN/COMMIT since the first SQLite commit, so
      // atomicity isn't the bug. Possible causes: DROP TABLE post-migration,
      // SQL import / restore from a pre-v16 backup over a v16+ schema_version,
      // or some edge case the wrapping doesn't catch. Cause may be operator
      // action; either way the practical fix is the same.
      //
      // All CREATE IF NOT EXISTS — zero-cost no-op for users without the
      // bug, fixes anyone who has it. Includes the role column from the
      // start so it matches v26's intent without needing v26 to ALTER on
      // this heal path.
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_id TEXT UNIQUE NOT NULL,
          key_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          label TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          role TEXT NOT NULL DEFAULT 'admin'
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

      // Belt-and-braces: if api_keys existed before this migration WITHOUT
      // the role column (i.e. v16-shape table that v26's ALTER skipped due
      // to tableExists=false on an earlier broken run, then someone manually
      // CREATEd it without role), backfill role.
      if (tableExists(db, 'api_keys') && !tableHasColumn(db, 'api_keys', 'role')) {
        db.exec(`ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      }
    },
  },
  {
    version: 28,
    up: (db) => {
      // E1 of 5-episode DAG live-coupling arc (docs/plans/2026-05-25-dag-e1-schema-v28.md).
      // Adds dirty-flag persistence for the existing DAG layer's level-2
      // summaries so E2 (child-write propagation) and E3 (sleep-cycle
      // rebuild) have somewhere to write + read the staleness signal. Adds
      // dag_level_3_built_at as a column (Keith Q5 pick: lets E5 entity-
      // profile build path land without a second migration).
      //
      // All columns are additive + DEFAULTed/nullable, so backfill is
      // automatic for existing rows. No min_compatible_binary bump: old
      // binaries (v1.12.x) ignore the columns on SELECTs that don't name
      // them; new binaries on old data hit this migration at openHippoDb
      // time before any DAG path touches summary_dirty.
      //
      // Precedent for column-only guards on memories: v25 (db.ts:827),
      // which added the DAG cache columns the same way. memories table
      // itself comes from v1 and is always present, so the tableExists
      // half of the v26/v27 guard pattern isn't load-bearing here.
      if (!tableHasColumn(db, 'memories', 'summary_dirty')) {
        db.exec(`ALTER TABLE memories ADD COLUMN summary_dirty INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'last_rebuilt_at')) {
        db.exec(`ALTER TABLE memories ADD COLUMN last_rebuilt_at TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'rebuild_count')) {
        db.exec(`ALTER TABLE memories ADD COLUMN rebuild_count INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'dag_level_3_built_at')) {
        // Reserved for E5: buildEntityProfiles will set this on level-3
        // rows when they're created. Always NULL for level 0/1/2 rows.
        db.exec(`ALTER TABLE memories ADD COLUMN dag_level_3_built_at TEXT`);
      }
    },
  },
  {
    version: 29,
    up: (db) => {
      // E2 prediction first-class object (docs/plans/2026-05-26-e2-prediction-object.md).
      // Adds a canonical predictions table for J3 reference-class /
      // planning-fallacy detector (a follow-up episode). Predictions
      // duplicate claim_text in the table itself so memory deletion
      // (forget/consolidate/archive) does not lose prediction data; FK
      // memory_id is NULLABLE with ON DELETE SET NULL.
      //
      // Cross-tenant safety: BEFORE INSERT + BEFORE UPDATE triggers
      // enforce tenant_id match against the referenced memory. SQLite's
      // ON DELETE SET NULL is incompatible with composite FK where one
      // side is NOT NULL, so the trigger pattern replaces a composite
      // FK target. Precedent: v14 memories.kind trigger pair at db.ts:298-322.
      //
      // CHECK constraint pins closure_state to (open|closed|closed-unknown).
      // J3 computes accuracy (clean vs regressed) from (estimate_value,
      // actual_value) at query time.
      if (!tableExists(db, 'predictions')) {
        db.exec(`
          CREATE TABLE predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            class_tag TEXT NOT NULL,
            claim_text TEXT NOT NULL,
            estimate_value REAL,
            estimate_unit TEXT,
            target_date TEXT,
            actual_value REAL,
            closure_state TEXT NOT NULL DEFAULT 'open'
              CHECK (closure_state IN ('open', 'closed', 'closed-unknown')),
            closed_at TEXT,
            closure_note TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_predictions_tenant_class
          ON predictions(tenant_id, class_tag, closure_state)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_predictions_memory
          ON predictions(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety: tenant_id must match the referenced memory's
        // tenant_id when memory_id IS NOT NULL. INSERT + UPDATE pair, mirroring
        // v14 memories.kind enforcement (db.ts:298-322).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_predictions_tenant_match_insert
          BEFORE INSERT ON predictions
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_predictions_tenant_match_update
          BEFORE UPDATE ON predictions
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'predictions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
      }
    },
  },
  {
    version: 30,
    up: (db) => {
      // E2 decision first-class object (docs/plans/2026-05-28-e2-decision-object.md).
      // Promotes `hippo decide` from a tagged memory (which decayed on a 90-day
      // half-life even while the decision was still in force) to a canonical
      // decisions table that is the source of truth. The memory mirror is kept
      // for recall but is no longer authoritative; memory_id is NULLABLE with
      // ON DELETE SET NULL so forget/consolidate/archive does not lose a
      // decision. Mirrors the v29 predictions tenant-match trigger pattern.
      //
      // status (active|superseded|closed): superseded carries a self-FK
      // superseded_by to the successor decision; closed is a terminal
      // retire-without-successor. A superseded_by same-tenant trigger makes
      // cross-tenant supersession unrepresentable at the schema level.
      if (!tableExists(db, 'decisions')) {
        db.exec(`
          CREATE TABLE decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            decision_text TEXT NOT NULL,
            context TEXT,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES decisions(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_decisions_tenant_status
          ON decisions(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_decisions_memory
          ON decisions(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety vs the referenced memory (mirrors predictions v29).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_decisions_tenant_match_insert
          BEFORE INSERT ON decisions
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'decisions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_decisions_tenant_match_update
          BEFORE UPDATE ON decisions
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'decisions.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        // Cross-tenant safety vs the successor decision (self-FK). superseded_by
        // is set only via UPDATE (the supersede path); the successor must share
        // the tenant. The successor row already exists in the same transaction
        // when this fires, so the subquery resolves.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_decisions_supersede_tenant_match_update
          BEFORE UPDATE ON decisions
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM decisions WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'decisions.superseded_by must reference a decision in the same tenant')
            END;
          END
        `);
      }
    },
  },
  {
    version: 31,
    up: (db) => {
      // E2 incident first-class object (docs/plans/2026-05-29-e2-incident-object.md).
      // Mirrors the v30 decisions block but for an open -> resolved -> closed
      // lifecycle (NOT supersede): there is no superseded_by self-FK and no
      // supersede trigger. An incident is a postmortem capsule: a recorded
      // operational event with a lifecycle and optional linked receipts (the
      // memories that are its evidence, stored as a JSON array of ids in
      // linked_memory_ids). The memory mirror is kept for recall but is not
      // authoritative; memory_id is NULLABLE with ON DELETE SET NULL so
      // forget/consolidate/archive does not lose an incident.
      //
      // status (open|resolved|closed): resolved records a resolution_text +
      // resolved_at and stays on record; closed is a terminal retire reachable
      // from open or resolved. Cross-tenant safety: BEFORE INSERT + BEFORE
      // UPDATE triggers enforce incidents.tenant_id == the referenced memory's
      // tenant_id (verbatim mirror of the v30 decisions tenant-match triggers).
      if (!tableExists(db, 'incidents')) {
        db.exec(`
          CREATE TABLE incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            incident_text TEXT NOT NULL,
            context TEXT,
            status TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'resolved', 'closed')),
            resolution_text TEXT,
            resolved_at TEXT,
            closed_at TEXT,
            linked_memory_ids TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_incidents_tenant_status
          ON incidents(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_incidents_memory
          ON incidents(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v30 decisions tenant-match triggers; no supersede trigger).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_incidents_tenant_match_insert
          BEFORE INSERT ON incidents
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'incidents.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_incidents_tenant_match_update
          BEFORE UPDATE ON incidents
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'incidents.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
      }
    },
  },
  {
    version: 32,
    up: (db) => {
      // E2 process first-class object (docs/plans/2026-05-29-e2-process-object.md).
      // A process is a "living process map": a named, ordered list of steps that
      // evolves. Unlike incident (open->resolved->closed, no supersede), process
      // REUSES the v30 decisions supersede path as its delta mechanism: a process
      // evolves by being superseded by a NEW VERSION that records what changed
      // (change_summary) and the full new state (steps), carrying a derived
      // version counter. So this table combines the v31 incidents tenant-match
      // trigger pair (vs the referenced memory) WITH the v30 decisions
      // superseded_by self-FK + supersede tenant-match trigger.
      //
      // status (active|superseded|closed): superseded carries a self-FK
      // superseded_by to the successor version; closed is a terminal
      // retire-without-successor (only an active head closes). The memory mirror
      // is kept for recall but is not authoritative; memory_id is NULLABLE with
      // ON DELETE SET NULL so forget/consolidate/archive does not lose a process.
      // steps is a JSON-encoded array of step strings (scoped v1; a normalized
      // process_steps table is deferred). version is server-derived
      // (predecessor.version + 1); change_summary is set on a successor row only.
      if (!tableExists(db, 'processes')) {
        db.exec(`
          CREATE TABLE processes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            process_name TEXT NOT NULL,
            description TEXT,
            steps TEXT NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES processes(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_processes_tenant_status
          ON processes(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_processes_memory
          ON processes(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v31 incidents / v30 decisions tenant-match triggers).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_processes_tenant_match_insert
          BEFORE INSERT ON processes
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'processes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_processes_tenant_match_update
          BEFORE UPDATE ON processes
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'processes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        // Cross-tenant safety vs the successor process (self-FK; verbatim mirror
        // of the v30 decisions supersede trigger). superseded_by is set only via
        // the supersede UPDATE; the successor must share the tenant. The successor
        // row already exists in the same transaction when this fires.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_processes_supersede_tenant_match_update
          BEFORE UPDATE ON processes
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM processes WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'processes.superseded_by must reference a process in the same tenant')
            END;
          END
        `);
      }
    },
  },
  {
    version: 33,
    up: (db) => {
      // E2 policy first-class object (docs/plans/2026-05-30-e2-policy-object.md).
      // The "bi-temporal-first" object type: a named rule/statement that is in
      // force over an EFFECTIVE-TIME range (valid_from required, valid_to nullable
      // = open-ended) and evolves via the v32 processes supersede machinery
      // (superseded_by self-FK + supersede tenant-match trigger + version +
      // change_summary). This table = the v32 processes table MINUS `steps`
      // (a policy has policy_text, not an ordered step list) PLUS the first-class
      // effective-time columns valid_from/valid_to. Valid-time is the queryable
      // axis (the as-of query loadPoliciesAsOf); transaction-time is present via
      // created_at + the supersede chain's superseded_at (time-travel deferred).
      //
      // All date inputs are normalized to canonical ISO-8601 datetime
      // (toISOString) at the store boundary before persist/compare, so the
      // fixed-width values sort lexically and the half-open [valid_from, valid_to)
      // as-of comparison is correct (plan-eng-critic round-1 CRIT fix).
      if (!tableExists(db, 'policies')) {
        db.exec(`
          CREATE TABLE policies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            policy_name TEXT NOT NULL,
            policy_text TEXT NOT NULL,
            valid_from TEXT NOT NULL,
            valid_to TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES policies(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_policies_tenant_status
          ON policies(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_policies_memory
          ON policies(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Supports the as-of query (active policies in force at a valid-time).
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_policies_asof
          ON policies(tenant_id, valid_from)
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v32 processes tenant-match triggers).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_policies_tenant_match_insert
          BEFORE INSERT ON policies
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'policies.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_policies_tenant_match_update
          BEFORE UPDATE ON policies
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'policies.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        // Cross-tenant safety vs the successor policy (self-FK; verbatim mirror of
        // the v32 processes supersede trigger).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_policies_supersede_tenant_match_update
          BEFORE UPDATE ON policies
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM policies WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'policies.superseded_by must reference a policy in the same tenant')
            END;
          END
        `);
      }
    },
  },
  {
    version: 34,
    up: (db) => {
      // E2 skill first-class object (docs/plans/2026-05-30-e2-skill-object.md).
      // A skill is a reusable, agent-followable capability: an `instructions` body
      // + an optional `trigger_text` (when to apply), evolving via the v32
      // processes supersede machinery (superseded_by self-FK + supersede
      // tenant-match trigger + version + change_summary). This table = the v32
      // processes table MINUS `steps` (a skill's content is a single instructions
      // body) PLUS `instructions` (NOT NULL) and `trigger_text`. "Executable" is
      // scoped to an agent-followable instruction that EXPORTS into the agent's
      // in-force rules (AGENTS.md / CLAUDE.md) via exportSkills; literal code
      // execution is deferred. NOTE: the column is `trigger_text`, NOT `trigger`,
      // because TRIGGER is a SQLite reserved keyword.
      if (!tableExists(db, 'skills')) {
        db.exec(`
          CREATE TABLE skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            instructions TEXT NOT NULL,
            trigger_text TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES skills(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_skills_tenant_status
          ON skills(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_skills_memory
          ON skills(memory_id) WHERE memory_id IS NOT NULL
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v32 processes tenant-match triggers).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_skills_tenant_match_insert
          BEFORE INSERT ON skills
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'skills.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_skills_tenant_match_update
          BEFORE UPDATE ON skills
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'skills.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        // Cross-tenant safety vs the successor skill (self-FK; verbatim mirror of
        // the v32 processes supersede trigger).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_skills_supersede_tenant_match_update
          BEFORE UPDATE ON skills
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM skills WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'skills.superseded_by must reference a skill in the same tenant')
            END;
          END
        `);
      }
    },
  },
  {
    version: 35,
    up: (db) => {
      // E2 project_brief first-class object
      // (docs/plans/2026-05-30-e2-project-brief-object.md). A project_brief is the
      // living, repo-scoped summary of a repository's state: a `summary` body
      // scoped to a `repo`, evolving via the v34 skills supersede machinery
      // (superseded_by self-FK + supersede tenant-match trigger + version +
      // change_summary). This table = the v34 skills table with
      // skill_name/trigger_text replaced by `repo` (the repo-scoping dimension)
      // PLUS `summary` (the brief body). The distinguishing op (refreshBrief, in
      // src/project-briefs.ts) auto-assembles the summary from the repo's receipts
      // (memory rows tagged path:<repo>); it needs no schema support beyond `repo`.
      // All column names were checked against SQLite reserved words (skill-episode
      // lesson re: `trigger`): repo/summary/version/status/etc. are non-reserved.
      if (!tableExists(db, 'project_briefs')) {
        db.exec(`
          CREATE TABLE project_briefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            repo TEXT NOT NULL,
            summary TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES project_briefs(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_project_briefs_tenant_status
          ON project_briefs(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_project_briefs_memory
          ON project_briefs(memory_id) WHERE memory_id IS NOT NULL
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_project_briefs_repo
          ON project_briefs(tenant_id, repo, status)
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v34 skills tenant-match triggers).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_project_briefs_tenant_match_insert
          BEFORE INSERT ON project_briefs
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'project_briefs.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_project_briefs_tenant_match_update
          BEFORE UPDATE ON project_briefs
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'project_briefs.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        // Cross-tenant safety vs the successor brief (self-FK; verbatim mirror of
        // the v34 skills supersede trigger).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_project_briefs_supersede_tenant_match_update
          BEFORE UPDATE ON project_briefs
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM project_briefs WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'project_briefs.superseded_by must reference a project_brief in the same tenant')
            END;
          END
        `);
      }
    },
  },
  {
    version: 36,
    up: (db) => {
      // E2 customer_note first-class object (the LAST E2 object)
      // (docs/plans/2026-06-01-e2-customer-note-object.md). A customer_note is a
      // discrete note recorded against an account/customer entity, evolving via the
      // v35 project_briefs supersede machinery (superseded_by self-FK + supersede
      // tenant-match trigger + version + change_summary). This table = the v35
      // project_briefs table with repo/summary replaced by `customer` (the
      // entity-scoping dimension; a free-form account/customer id - the entities
      // table is unbuilt E3.1, so a FK is deferred) PLUS `note` (the note body).
      // MANY notes per customer (each its own supersede chain), unlike the
      // one-summary-per-repo project_brief. All column names checked against SQLite
      // reserved words (skill-episode lesson, codebase-audit rule 10): customer/note/
      // version/status/etc. are non-reserved.
      if (!tableExists(db, 'customer_notes')) {
        db.exec(`
          CREATE TABLE customer_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            tenant_id TEXT NOT NULL,
            customer TEXT NOT NULL,
            note TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'superseded', 'closed')),
            superseded_by INTEGER,
            superseded_at TEXT,
            change_summary TEXT,
            closed_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
            FOREIGN KEY (superseded_by) REFERENCES customer_notes(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_customer_notes_tenant_status
          ON customer_notes(tenant_id, status)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_customer_notes_memory
          ON customer_notes(memory_id) WHERE memory_id IS NOT NULL
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_customer_notes_customer
          ON customer_notes(tenant_id, customer, status)
        `);
        // Cross-tenant safety vs the referenced memory (verbatim mirror of the
        // v35 project_briefs tenant-match triggers).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_customer_notes_tenant_match_insert
          BEFORE INSERT ON customer_notes
          WHEN NEW.memory_id IS NOT NULL
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'customer_notes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_customer_notes_tenant_match_update
          BEFORE UPDATE ON customer_notes
          WHEN NEW.memory_id IS NOT NULL
            AND (NEW.memory_id IS NOT OLD.memory_id OR NEW.tenant_id IS NOT OLD.tenant_id)
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'customer_notes.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        // Cross-tenant safety vs the successor note (self-FK; verbatim mirror of the
        // v35 project_briefs supersede trigger).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_customer_notes_supersede_tenant_match_update
          BEFORE UPDATE ON customer_notes
          WHEN NEW.superseded_by IS NOT NULL
            AND NEW.superseded_by IS NOT OLD.superseded_by
          BEGIN
            SELECT CASE
              WHEN NEW.tenant_id != (SELECT tenant_id FROM customer_notes WHERE id = NEW.superseded_by)
              THEN RAISE(ABORT, 'customer_notes.superseded_by must reference a customer_note in the same tenant')
            END;
          END
        `);
      }
    },
  },
  {
    version: 37,
    up: (db) => {
      // E3.3 graph-on-consolidated guard (docs/plans/2026-06-01-e3-graph-guard.md).
      // The graph layer (entities + relations) sits ON TOP OF consolidated state and
      // must NEVER index the raw layer. The substrate: entities + relations +
      // graph_extraction_queue, each FK-ing to memories and guarded so they can only
      // reference CONSOLIDATED memories (kind IN ('distilled','superseded')), never
      // kind='raw'. New tables -> real CHECK constraints (unlike the ALTER'd memories,
      // whose kind CHECK lives in triggers). The kind/source MATCH (source_kind ==
      // the FK'd memory's actual kind) cannot be a CHECK (CHECK can't subquery), so it
      // is a BEFORE INSERT *and* BEFORE UPDATE trigger (the subquery-capable pattern
      // from the v30 decisions / predictions tenant-match triggers). Both INSERT and
      // UPDATE are guarded: an INSERT-only guard is bypassable via a raw SQL UPDATE
      // that moves a row onto a raw memory (plan-eng-critic 2026-06-01). All column
      // names checked vs SQL reserved words (rule 10): rel_type avoids REFERENCES.
      if (!tableExists(db, 'entities')) {
        db.exec(`
          CREATE TABLE entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            entity_type TEXT NOT NULL
              CHECK (entity_type IN ('person', 'project', 'customer', 'system', 'policy', 'decision')),
            name TEXT NOT NULL,
            memory_id TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
            created_at TEXT NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_memory ON entities(memory_id)`);
        db.exec(`
          CREATE TABLE relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            from_entity_id INTEGER NOT NULL,
            to_entity_id INTEGER NOT NULL,
            rel_type TEXT NOT NULL
              CHECK (rel_type IN ('owns', 'supersedes', 'depends-on', 'blocked-by', 'references')),
            memory_id TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
            created_at TEXT NOT NULL,
            FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
            FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_tenant ON relations(tenant_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_memory ON relations(memory_id)`);
        db.exec(`
          CREATE TABLE graph_extraction_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            memory_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('distilled', 'superseded')),
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'processed', 'skipped')),
            enqueued_at TEXT NOT NULL,
            processed_at TEXT,
            FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_queue_status ON graph_extraction_queue(tenant_id, status)`);

        // entities guard: source_kind must equal the FK'd memory's actual kind (so a
        // raw memory or a lying source_kind both ABORT), and tenant must match. Both
        // INSERT and UPDATE (UPDATE fires when memory_id/source_kind/tenant_id change).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_insert
          BEFORE INSERT ON entities
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_update
          BEFORE UPDATE ON entities
          WHEN NEW.memory_id IS NOT OLD.memory_id
            OR NEW.source_kind IS NOT OLD.source_kind
            OR NEW.tenant_id IS NOT OLD.tenant_id
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);

        // relations guard: source_kind must equal the FK'd memory's kind; tenant must
        // match the memory AND both endpoint entities (no cross-tenant edges).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_relations_consolidated_only_insert
          BEFORE INSERT ON relations
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_relations_consolidated_only_update
          BEFORE UPDATE ON relations
          WHEN NEW.memory_id IS NOT OLD.memory_id
            OR NEW.source_kind IS NOT OLD.source_kind
            OR NEW.tenant_id IS NOT OLD.tenant_id
            OR NEW.from_entity_id IS NOT OLD.from_entity_id
            OR NEW.to_entity_id IS NOT OLD.to_entity_id
          BEGIN
            SELECT CASE
              WHEN NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
              THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
            END;
          END
        `);

        // graph_extraction_queue guard: kind must equal the FK'd memory's actual kind
        // (so a raw memory ABORTs), and tenant must match. INSERT and UPDATE.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_graph_queue_consolidated_only_insert
          BEFORE INSERT ON graph_extraction_queue
          BEGIN
            SELECT CASE
              WHEN NEW.kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.kind must equal the referenced memory kind; only consolidated memories are queued (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_graph_queue_consolidated_only_update
          BEFORE UPDATE ON graph_extraction_queue
          WHEN NEW.memory_id IS NOT OLD.memory_id
            OR NEW.kind IS NOT OLD.kind
            OR NEW.tenant_id IS NOT OLD.tenant_id
          BEGIN
            SELECT CASE
              WHEN NEW.kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.kind must equal the referenced memory kind; only consolidated memories are queued (no raw)')
              WHEN NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
              THEN RAISE(ABORT, 'graph_extraction_queue.tenant_id must match memories.tenant_id for the referenced memory')
            END;
          END
        `);

        // Reverse guard (codex-review-critic 2026-06-01, P1): the graph-table triggers
        // only fire on writes to the GRAPH tables. They do NOT fire when an
        // already-indexed memory is later mutated. So 'UPDATE memories SET kind=raw'
        // (or a tenant change) on a memory the graph references would silently leave
        // entity/relation/queue rows pointing at a raw / cross-tenant memory while
        // their source_kind stays 'distilled' - bypassing the central 'graph never
        // indexes raw' invariant after insertion. This trigger closes that direction:
        // a memory cannot be reclassified to raw, nor moved cross-tenant, WHILE the
        // graph references it (rebuild/remove the graph rows first). Cheap: the EXISTS
        // checks are only evaluated when kind actually becomes raw or tenant changes.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_memories_graph_referenced_guard
          BEFORE UPDATE ON memories
          WHEN (NEW.kind IS NOT OLD.kind OR NEW.tenant_id IS NOT OLD.tenant_id)
            AND (
              EXISTS (SELECT 1 FROM entities WHERE memory_id = OLD.id)
              OR EXISTS (SELECT 1 FROM relations WHERE memory_id = OLD.id)
              OR EXISTS (SELECT 1 FROM graph_extraction_queue WHERE memory_id = OLD.id)
            )
          BEGIN
            SELECT RAISE(ABORT, 'cannot change the kind or tenant of a memory while the graph references it (E3.3 graph-on-consolidated guard); a graph-referenced memory is immutable in kind/tenant - rebuild/remove the graph rows first, or rebuild them after supersession');
          END
        `);
        // Reverse guard #2 (codex-review-critic 2026-06-01 retry, P2): an entity that is
        // a relation endpoint cannot be moved cross-tenant. The entity UPDATE trigger
        // validates the entity against its source memory, but an existing relation
        // pointing at the entity is NOT re-validated, so a raw 'UPDATE entities SET
        // tenant_id=?, memory_id=?' to another tenant would leave a tenant-A relation
        // pointing at a tenant-B entity. Block the tenant move while the entity is
        // referenced by any relation (rebuild the relations first).
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_entities_no_tenant_move_when_referenced
          BEFORE UPDATE ON entities
          WHEN NEW.tenant_id IS NOT OLD.tenant_id
            AND EXISTS (SELECT 1 FROM relations WHERE from_entity_id = OLD.id OR to_entity_id = OLD.id)
          BEGIN
            SELECT RAISE(ABORT, 'cannot move an entity cross-tenant while a relation references it as an endpoint (E3.3 graph-on-consolidated guard); rebuild/remove the relations first');
          END
        `);
      }
    },
  },
  {
    version: 38,
    up: (db) => {
      // E2-provenance: anchor graph entity/relation provenance to the authoritative E2
      // object (decision/policy/customer-note/project-brief) instead of the decaying
      // memory mirror (docs/plans/2026-06-03-graph-e2-provenance.md). An in-force E2
      // object must STAY in the graph after its mirror memory is forgotten or
      // consolidation-pruned. The graph is a PURE DERIVED CACHE (clearGraph + rebuild on
      // every `graph extract` / `sleep`), so v38 DROPs+recreates entities/relations (no
      // data copy) and the next extract repopulates. graph_extraction_queue is untouched.
      //
      // Two provenance paths, "at least one, no raw":
      //  - memory path (memory_id NOT NULL): source_kind must equal the FK'd memory's live
      //    kind and that kind is distilled|superseded (raw still ABORTs) + tenant-match.
      //  - object path (memory_id NULL): source_object_type/id must reference an EXISTING
      //    same-tenant E2 row whose status is active|superseded (not closed). E2 objects
      //    are consolidated BY CONSTRUCTION, so the no-raw invariant still holds.
      //  - all-null is rejected.
      //
      // memory_id is now NULLABLE with ON DELETE SET NULL (was NOT NULL / CASCADE), so a
      // mirror forget/consolidate nulls the recall pointer without dropping the row. NOTE
      // (empirically verified, contradicts the SQLite docs): node:sqlite DOES fire the
      // BEFORE UPDATE guard from the FK SET NULL action even with recursive_triggers OFF.
      // So the *_consolidated_only_UPDATE triggers deliberately OMIT the all-null ABORT
      // (kept on INSERT) - otherwise a mirror delete of a memory-only row would be blocked.
      // See the per-trigger comments below. A SET NULL leaves source_kind at its old value
      // by design (the object path is distilled-by-construction; source_kind is only
      // re-checked when memory_id NOT NULL).
      // source_object_id is a SOFT (type,id) pointer (no hard FK) the rebuild re-validates,
      // so a legitimate E2 hard-delete is never blocked; a `closed` E2 row drops at next
      // extract. SQLite cannot parametrize a table name in a trigger, so the object-path
      // validation is an explicit 4-way CASE (one arm per E2 table).

      // Drop child (relations FK entities) first, then parent.
      db.exec('DROP TABLE IF EXISTS relations');
      db.exec('DROP TABLE IF EXISTS entities');

      db.exec(`
        CREATE TABLE entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          entity_type TEXT NOT NULL
            CHECK (entity_type IN ('person', 'project', 'customer', 'system', 'policy', 'decision')),
          name TEXT NOT NULL,
          memory_id TEXT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
          source_object_type TEXT
            CHECK (source_object_type IS NULL OR source_object_type IN ('decision', 'policy', 'customer', 'project')),
          source_object_id INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_memory ON entities(memory_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_source_object ON entities(source_object_type, source_object_id) WHERE source_object_id IS NOT NULL`);

      db.exec(`
        CREATE TABLE relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          from_entity_id INTEGER NOT NULL,
          to_entity_id INTEGER NOT NULL,
          rel_type TEXT NOT NULL
            CHECK (rel_type IN ('owns', 'supersedes', 'depends-on', 'blocked-by', 'references')),
          memory_id TEXT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('distilled', 'superseded')),
          source_object_type TEXT
            CHECK (source_object_type IS NULL OR source_object_type IN ('decision', 'policy', 'customer', 'project')),
          source_object_id INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_tenant ON relations(tenant_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_memory ON relations(memory_id)`);
      // Mirrors idx_entities_source_object: removeGraphEntitiesForObject (close-time cleanup)
      // deletes relations by (source_object_type, source_object_id), so index that pair.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source_object ON relations(source_object_type, source_object_id) WHERE source_object_id IS NOT NULL`);

      // entities guard (dual-provenance): at least one valid provenance, no raw.
      //  - all-null  -> ABORT.
      //  - memory path (memory_id NOT NULL): source_kind == the FK'd memory's kind
      //    (raw / lying source_kind ABORT) AND tenant-match.
      //  - object path (memory_id NULL): the (type,id) points at an EXISTING same-tenant
      //    E2 row whose status is active|superseded (explicit 4-way CASE per table).
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_insert
        BEFORE INSERT ON entities
        BEGIN
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NULL AND NEW.source_object_id IS NULL
            THEN RAISE(ABORT, 'graph row needs a memory or a source object')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded decision in the same tenant')
            WHEN NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded policy in the same tenant')
            WHEN NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded project_brief in the same tenant')
          END;
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_entities_consolidated_only_update
        BEFORE UPDATE ON entities
        WHEN NEW.memory_id IS NOT OLD.memory_id
          OR NEW.source_kind IS NOT OLD.source_kind
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.source_object_type IS NOT OLD.source_object_type
          OR NEW.source_object_id IS NOT OLD.source_object_id
        BEGIN
          -- NO all-null ABORT on UPDATE: node:sqlite fires this BEFORE UPDATE trigger from
          -- the FK ON DELETE SET NULL action even with recursive_triggers OFF (empirically
          -- verified - the plan's "SET NULL does not fire the guard" premise is false for
          -- this build). A mirror forget on a memory-only entity legitimately produces an
          -- all-null row; aborting here would block the memory delete. The INSERT guard
          -- still forbids CREATING a provenance-less row, and the next graph rebuild clears
          -- any all-null orphan. A raw UPDATE to all-null is harmless (not recall-surfaced).
          -- Object-path STATUS is validated only when the object columns THEMSELVES change
          -- (an explicit re-point), NOT on the FK ON DELETE SET NULL transition (which changes
          -- only memory_id). This threads the needle (codex P1 + P2 round 4): the SET NULL of a
          -- since-closed object's mirror is NOT blocked (object cols unchanged -> object checks
          -- skip), while an explicit raw UPDATE that re-points the row to a bad/closed/cross-
          -- tenant object IS rejected. all-or-none + memory-path (raw/tenant) always apply.
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'entities.source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'entities.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded decision in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded policy in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'entities.source_object must reference an active/superseded project_brief in the same tenant')
          END;
        END
      `);

      // relations guard (dual-provenance) + the existing from/to endpoint same-tenant checks.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_relations_consolidated_only_insert
        BEFORE INSERT ON relations
        BEGIN
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NULL AND NEW.source_object_id IS NULL
            THEN RAISE(ABORT, 'graph row needs a memory or a source object')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded decision in the same tenant')
            WHEN NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded policy in the same tenant')
            WHEN NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded project_brief in the same tenant')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
          END;
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_relations_consolidated_only_update
        BEFORE UPDATE ON relations
        WHEN NEW.memory_id IS NOT OLD.memory_id
          OR NEW.source_kind IS NOT OLD.source_kind
          OR NEW.tenant_id IS NOT OLD.tenant_id
          OR NEW.source_object_type IS NOT OLD.source_object_type
          OR NEW.source_object_id IS NOT OLD.source_object_id
          OR NEW.from_entity_id IS NOT OLD.from_entity_id
          OR NEW.to_entity_id IS NOT OLD.to_entity_id
        BEGIN
          -- NO all-null ABORT on UPDATE (same reason as the entities UPDATE trigger): the FK
          -- ON DELETE SET NULL fires this trigger in node:sqlite, and a mirror forget on a
          -- memory-only relation legitimately nulls memory_id. The INSERT guard still forbids
          -- creating a provenance-less relation; the rebuild clears any orphan.
          -- Object-path STATUS validated only on an explicit object-column change, NOT on the
          -- FK SET NULL transition (see the entities UPDATE trigger): SET NULL of a since-closed
          -- object's mirror is not blocked (object cols unchanged), while an explicit re-point to
          -- a bad object is rejected. all-or-none + memory-path + endpoint checks always apply.
          SELECT CASE
            WHEN (NEW.source_object_type IS NULL AND NEW.source_object_id IS NOT NULL)
              OR (NEW.source_object_type IS NOT NULL AND NEW.source_object_id IS NULL)
            THEN RAISE(ABORT, 'relations.source_object_type and source_object_id must be set together (all-or-none)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.source_kind != (SELECT kind FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.source_kind must equal the referenced memory kind; the graph indexes consolidated state only (no raw)')
            WHEN NEW.memory_id IS NOT NULL AND NEW.tenant_id != (SELECT tenant_id FROM memories WHERE id = NEW.memory_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match memories.tenant_id for the referenced memory')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='decision'
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded decision in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='policy'
              AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded policy in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='customer'
              AND NOT EXISTS (SELECT 1 FROM customer_notes WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded customer_note in the same tenant')
            WHEN (NEW.source_object_type IS NOT OLD.source_object_type OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.tenant_id IS NOT OLD.tenant_id)
              AND NEW.source_object_type ='project'
              AND NOT EXISTS (SELECT 1 FROM project_briefs WHERE id = NEW.source_object_id AND tenant_id = NEW.tenant_id AND status IN ('active', 'superseded'))
            THEN RAISE(ABORT, 'relations.source_object must reference an active/superseded project_brief in the same tenant')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.from_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the from_entity tenant (no cross-tenant edges)')
            WHEN NEW.tenant_id != (SELECT tenant_id FROM entities WHERE id = NEW.to_entity_id)
            THEN RAISE(ABORT, 'relations.tenant_id must match the to_entity tenant (no cross-tenant edges)')
          END;
        END
      `);

      // Recreated VERBATIM from v37 (logic unchanged): an entity that is a relation
      // endpoint cannot be moved cross-tenant while referenced. trg_memories_graph_referenced_guard
      // (on memories) and trg_graph_queue_* (on graph_extraction_queue) are NOT recreated
      // here: those tables are not dropped by v38, so the triggers survive.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_entities_no_tenant_move_when_referenced
        BEFORE UPDATE ON entities
        WHEN NEW.tenant_id IS NOT OLD.tenant_id
          AND EXISTS (SELECT 1 FROM relations WHERE from_entity_id = OLD.id OR to_entity_id = OLD.id)
        BEGIN
          SELECT RAISE(ABORT, 'cannot move an entity cross-tenant while a relation references it as an endpoint (E3.3 graph-on-consolidated guard); rebuild/remove the relations first');
        END
      `);
    },
  },
  {
    version: 39,
    up: (db, ctx) => {
      // Memory scope isolation (docs/plans/2026-07-01-memory-scope-isolation.md).
      // origin_project: '<name>' = owned by that project, '' = user-global,
      // NULL = legacy/unknown (ambient context treats NULL as deny).
      if (!tableHasColumn(db, 'memories', 'origin_project')) {
        db.exec(`ALTER TABLE memories ADD COLUMN origin_project TEXT`);
      }
      // Backfill on store-location evidence only (no path-tag guessing):
      // 1. Rows shared from a project carry source 'shared:<project>:<ts>' -
      //    take <project>; a share whose <project> is the home dir basename
      //    maps to '' (user-global).
      // 2. Every other row was written into THIS store, so it takes the
      //    store's own origin: `<project>/.hippo` -> '<project>', the
      //    home/global store -> '' (user-global).
      // Rows stay NULL only when no hippoRoot was provided.
      const hippoRoot = ctx?.hippoRoot;
      if (hippoRoot) {
        // Provenance-source evidence first (shared:<project>: / promoted:<localRoot>,
        // parsed by the same helper the markdown-import stamp uses), then the
        // store's own location for everything else.
        const homeName = path.basename(os.homedir()).toLowerCase();
        const sourcedRows = db.prepare(
          `SELECT id, source FROM memories WHERE origin_project IS NULL AND (source LIKE 'shared:%' OR source LIKE 'promoted:%')`,
        ).all() as Array<{ id: string; source: string }>;
        const setOrigin = db.prepare(`UPDATE memories SET origin_project = ? WHERE id = ?`);
        for (const row of sourcedRows) {
          const origin = originFromSource(row.source, homeName);
          if (origin === null) continue;
          setOrigin.run(origin, row.id);
        }
        // The global root itself is ALWAYS user-global (''), regardless of
        // what surrounds it on disk - a HIPPO_HOME inside a dotfiles git
        // repo must not stamp the whole corpus with that repo's name.
        const storeOrigin = isGlobalStoreRoot(hippoRoot)
          ? ''
          : deriveOriginProject(path.dirname(hippoRoot));
        db.prepare(`UPDATE memories SET origin_project = ? WHERE origin_project IS NULL`).run(storeOrigin);
      }
      // Rollback-safety guard (v24 precedent): a pre-isolation binary opening
      // this DB would ignore origin_project and the secret veto and resume
      // injecting cross-project rows. 1.24.0 is the first version with the
      // isolation behavior. Forward-only - never lower an existing minimum.
      const existingMin = (db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as { value?: string } | undefined)?.value;
      if (!existingMin || compareSemver('1.24.0', existingMin) > 0) {
        db.prepare(`INSERT INTO meta(key, value) VALUES('min_compatible_binary', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('1.24.0');
      }
    },
  },
];

function tableHasColumn(db: DatabaseSyncLike, tableName: string, columnName: string): boolean {
  if (!/^[a-z_]+$/i.test(tableName)) throw new Error(`Invalid table name: ${tableName}`);
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function tableExists(db: DatabaseSyncLike, tableName: string): boolean {
  if (!/^[a-z_]+$/i.test(tableName)) throw new Error(`Invalid table name: ${tableName}`);
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName) as { name?: string } | undefined;
  return !!row?.name;
}

export function getHippoDbPath(hippoRoot: string): string {
  return path.join(hippoRoot, 'hippo.db');
}

export function getCurrentSchemaVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

function readMinCompatibleBinary(db: DatabaseSyncLike): string | null {
  // Tolerate the meta table not yet existing on a fresh DB.
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
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
    runMigrations(db, hippoRoot);
    // Path A backfill: delete any orphan markdown mirrors for already-archived
    // raw_archive rows. Idempotent via per-row raw_archive.mirror_cleaned_at
    // (v21). Wrapped in try/catch — a filesystem failure must not prevent DB open.
    try {
      cleanupArchivedMirrors(hippoRoot, db);
    } catch (cleanupErr) {
      console.error('openHippoDb: cleanupArchivedMirrors failed (non-fatal):', cleanupErr);
    }
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

function runMigrations(db: DatabaseSyncLike, hippoRoot?: string): void {
  ensureMetaTable(db);

  // v1.3.1 rollback-safety guard. Schema v24 stamped meta.min_compatible_binary;
  // older binaries that lack the generic *:private:* default-deny filter would
  // leak github:private:* rows on no-scope recall. Refuse to open a DB stamped
  // with a min newer than this binary's version. Read BEFORE migrations so a
  // stale v1.2.0 binary cannot apply unknown future migrations either.
  const minRequired = readMinCompatibleBinary(db);
  if (minRequired && compareSemver(minRequired, PACKAGE_VERSION) > 0) {
    throw new Error(
      `hippo-memory: this database requires hippo-memory >= ${minRequired}, but the running binary is ${PACKAGE_VERSION}. ` +
      `Upgrade hippo-memory to open this database. Running an older binary against this DB would leak private rows that the ` +
      `older filter does not recognize.`,
    );
  }

  let currentVersion = getSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    db.exec('BEGIN');
    try {
      migration.up(db, { hippoRoot });
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
