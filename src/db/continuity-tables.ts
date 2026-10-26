import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { ensureMetaTable } from './meta.js';
import { MIGRATIONS } from './migrations/index.js';
import { placeholders } from './sql.js';
import { tableExists } from './tables.js';

/** The session, card and quarantine tables a store can lose after its stamp passed their migration. */
export const HEALED_TABLES = [
  'task_snapshots',
  'session_events',
  'session_handoffs',
  'cards',
  'card_deps',
  'card_runs',
  'card_comments',
  'memory_quarantine',
  'session_owners',
] as const;

let chainDdl: ReadonlyMap<string, readonly string[]> | undefined;

// Before the loop on stamped stores: the chain never re-runs a stamped migration, and v4/v16/v22 ALTER or read these
// tables. IF NOT EXISTS because this runs outside the migration lock, where two processes may heal one store.
export function ensureContinuityTables(db: DatabaseSyncLike): void {
  const missing = HEALED_TABLES.filter((table) => !tableExists(db, table));
  if (missing.length === 0) return;
  chainDdl ??= tableDdlFromChain();
  for (const table of missing) for (const ddl of chainDdl.get(table) ?? []) db.exec(ddl);
}

/** Each healed table's CREATE TABLE, then its indexes, as the migration chain leaves them on an empty database. */
function tableDdlFromChain(): ReadonlyMap<string, readonly string[]> {
  const db = new DatabaseSync(':memory:');
  try {
    ensureMetaTable(db);
    // No root: only v39 reads it, to backfill rows an empty database does not have.
    for (const migration of MIGRATIONS) migration.up(db, {});
    // SAFETY: rows follow the selected columns, and the WHERE drops the autoindexes whose sql is NULL.
    const rows = db
      .prepare(
        `SELECT tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index') ` +
          `AND tbl_name IN (${placeholders(HEALED_TABLES.length)}) ORDER BY type DESC, name`,
      )
      .all(...HEALED_TABLES) as Array<{ tbl_name: string; sql: string }>;
    const ddl = new Map<string, string[]>();
    for (const { tbl_name, sql } of rows) ddl.set(tbl_name, [...(ddl.get(tbl_name) ?? []), ifNotExists(sql)]);
    return ddl;
  } finally {
    db.close();
  }
}

// sqlite_master keeps each CREATE without its IF NOT EXISTS.
const ifNotExists = (sql: string): string =>
  sql.replace(/^CREATE (UNIQUE )?(TABLE|INDEX) /, 'CREATE $1$2 IF NOT EXISTS ');

// The quarantine index is here too, so a store that lost only an index heals without its table missing.
export const CONTINUITY_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_task_snapshots_status_updated ON task_snapshots(status, updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_status ON task_snapshots(tenant_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_scope ON task_snapshots(tenant_id, scope, status)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_session_created ON session_events(session_id, created_at DESC, id ` +
    `DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_task_created ON session_events(task, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_tenant_session ON session_events(tenant_id, session_id, created_at ` +
    `DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_session ON session_handoffs(session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_session ON session_handoffs(tenant_id, session_id, ` +
    `created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_outcome ON session_handoffs(tenant_id, outcome, created_at ` +
    `DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cards_tenant_status ON cards(tenant_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_card_deps_tenant_child ON card_deps(tenant_id, child)`,
  `CREATE INDEX IF NOT EXISTS idx_card_deps_tenant_parent ON card_deps(tenant_id, parent)`,
  `CREATE INDEX IF NOT EXISTS idx_card_runs_tenant_card ON card_runs(tenant_id, card, started DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_card_comments_tenant_card ON card_comments(tenant_id, card_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_card ON session_handoffs(tenant_id, card_id, created_at ` +
    `DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_task_snapshots_owner ON task_snapshots(tenant_id, owner_subject, origin_project, ` +
    `status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_handoffs_owner ON session_handoffs(tenant_id, owner_subject, ` +
    `origin_project, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_quarantine_status ON memory_quarantine(tenant_id, status, quarantined_at DESC)`,
] as const;

// A client retry carries the same request id, so a repeat finds the earlier row instead of writing again.
export const REQUEST_INDEX_DDL = {
  compactions:
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_compactions_request ON compactions(tenant_id, request_id) ` +
    `WHERE request_id IS NOT NULL`,
  failure_log:
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_failure_log_request ON failure_log(tenant_id, request_id) ` +
    `WHERE request_id IS NOT NULL`,
} as const;

// After the loop: tenant_id (v16) and scope (v23) do not exist yet on a genuine old store.
export function ensureContinuityIndexes(db: DatabaseSyncLike): void {
  for (const ddl of CONTINUITY_INDEX_DDL) db.exec(ddl);
  // A store that lost one of these tables still opens, so its hooks can log the failed step and run the rest.
  for (const [table, ddl] of Object.entries(REQUEST_INDEX_DDL)) if (tableExists(db, table)) db.exec(ddl);
}
