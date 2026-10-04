import type { DatabaseSyncLike } from './sqlite.js';
import { META_TABLE_DDL } from './meta.js';

// Shared by migration v48 and the stamped-store self-heal below.
export const MEMORY_QUARANTINE_DDL = `
    CREATE TABLE IF NOT EXISTS memory_quarantine (
      tenant_id      TEXT NOT NULL DEFAULT 'default',
      memory_id      TEXT NOT NULL,
      original_scope TEXT,
      reason         TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      quarantined_at TEXT NOT NULL,
      decided_at     TEXT,
      decided_by     TEXT,
      PRIMARY KEY (tenant_id, memory_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_memory_quarantine_status
      ON memory_quarantine(tenant_id, status, quarantined_at DESC);
`;

const TASK_SNAPSHOTS_DDL = `
    CREATE TABLE IF NOT EXISTS task_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      summary TEXT NOT NULL,
      next_step TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_id TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      scope TEXT
    )
  `;

const SESSION_EVENTS_DDL = `
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      task TEXT,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      scope TEXT
    )
  `;

const SESSION_HANDOFFS_DDL = `
    CREATE TABLE IF NOT EXISTS session_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      repo_root TEXT,
      task_id TEXT,
      summary TEXT NOT NULL,
      next_action TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      scope TEXT,
      constraints_json TEXT,
      evidence_json TEXT,
      outcome TEXT,
      target_runtime TEXT,
      card_id TEXT
    )
  `;

const CARDS_DDL = `
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      assignee_runtime TEXT,
      repo TEXT,
      contract TEXT,
      budget INTEGER,
      lease_until TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      scope TEXT
    ) WITHOUT ROWID
  `;

const CARD_DEPS_DDL = `
    CREATE TABLE IF NOT EXISTS card_deps (
      parent TEXT NOT NULL REFERENCES cards(id),
      child TEXT NOT NULL REFERENCES cards(id),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      PRIMARY KEY (parent, child)
    ) WITHOUT ROWID
  `;

const CARD_RUNS_DDL = `
    CREATE TABLE IF NOT EXISTS card_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card TEXT NOT NULL REFERENCES cards(id),
      runtime TEXT NOT NULL,
      session_id TEXT,
      started TEXT NOT NULL,
      ended TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `;

const CARD_COMMENTS_DDL = `
    CREATE TABLE IF NOT EXISTS card_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL REFERENCES cards(id),
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `;

// Before the loop on stamped stores: a table lost after its migration stamped
// is never re-migrated, and v4/v16/v22 ALTER or read it. Fresh stores use the chain.
export function ensureContinuityTables(db: DatabaseSyncLike): void {
  for (const ddl of CONTINUITY_TABLE_DDL) db.exec(ddl);
}

const CONTINUITY_TABLE_DDL = [
  TASK_SNAPSHOTS_DDL,
  SESSION_EVENTS_DDL,
  SESSION_HANDOFFS_DDL,
  CARDS_DDL,
  CARD_DEPS_DDL,
  CARD_RUNS_DDL,
  CARD_COMMENTS_DDL,
  MEMORY_QUARANTINE_DDL,
] as const;

const CONTINUITY_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_task_snapshots_status_updated ON task_snapshots(status, updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_status ON task_snapshots(tenant_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_scope ON task_snapshots(tenant_id, scope, status)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_session_created ON session_events(session_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_task_created ON session_events(task, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_tenant_session ON session_events(tenant_id, session_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_session ON session_handoffs(session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_session ON session_handoffs(tenant_id, session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_outcome ON session_handoffs(tenant_id, outcome, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cards_tenant_status ON cards(tenant_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_card_deps_tenant_child ON card_deps(tenant_id, child)`,
  `CREATE INDEX IF NOT EXISTS idx_card_deps_tenant_parent ON card_deps(tenant_id, parent)`,
  `CREATE INDEX IF NOT EXISTS idx_card_runs_tenant_card ON card_runs(tenant_id, card, started DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_card_comments_tenant_card ON card_comments(tenant_id, card_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_card ON session_handoffs(tenant_id, card_id, created_at DESC)`,
] as const;

// Lives with the other re-asserted DDL so the required-object list below derives from one place.
export const MEMORIES_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tags)`;

const CREATED_NAME = /CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;

/** Names of every table and index a `CREATE ... IF NOT EXISTS` in `ddl` makes. */
export function createdObjectNames(ddl: string): string[] {
  return [...ddl.matchAll(CREATED_NAME)].map((m) => m[1]);
}

/** Every object runMigrations re-asserts on a stamped store; the open fast path requires all of them. */
export const REQUIRED_SCHEMA_OBJECTS: readonly string[] = Object.freeze(
  [META_TABLE_DDL, ...CONTINUITY_TABLE_DDL, ...CONTINUITY_INDEX_DDL, MEMORIES_FTS_DDL].flatMap(createdObjectNames),
);

// After the loop: tenant_id (v16) and scope (v23) do not exist yet on a genuine old store.
export function ensureContinuityIndexes(db: DatabaseSyncLike): void {
  for (const ddl of CONTINUITY_INDEX_DDL) db.exec(ddl);
}
