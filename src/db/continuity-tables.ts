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

/** The indexes the chain puts on those tables and the two request indexes, by name: the open's probe counts them, and
 * a missing one is made again from the chain. */
export const HEALED_INDEXES = [
  'idx_task_snapshots_status_updated',
  'idx_task_snapshots_tenant_status',
  'idx_task_snapshots_tenant_scope',
  'idx_task_snapshots_owner',
  'idx_session_events_session_created',
  'idx_session_events_task_created',
  'idx_session_events_tenant_session',
  'idx_session_handoffs_session',
  'idx_session_handoffs_tenant_session',
  'idx_session_handoffs_tenant_outcome',
  'idx_session_handoffs_tenant_card',
  'idx_session_handoffs_owner',
  'idx_cards_tenant_status',
  'idx_card_deps_tenant_child',
  'idx_card_deps_tenant_parent',
  'idx_card_runs_tenant_card',
  'idx_card_comments_tenant_card',
  'idx_memory_quarantine_status',
  'idx_compactions_request',
  'idx_failure_log_request',
] as const;

// The request indexes' tables: never healed, since a store that lost one still opens so its hooks can log the step.
const REQUEST_TABLES = ['compactions', 'failure_log'] as const;

interface ChainObject {
  readonly table: string;
  readonly sql: string;
}

let chainObjects: ReadonlyMap<string, ChainObject> | undefined;

// Before the loop on stamped stores: the chain never re-runs a stamped migration, and v4/v16/v22 ALTER or read these
// tables. IF NOT EXISTS because this runs outside the migration lock, where two processes may heal one store.
export function ensureContinuityTables(db: DatabaseSyncLike): void {
  const missing = new Set<string>(HEALED_TABLES.filter((table) => !tableExists(db, table)));
  if (missing.size === 0) return;
  chainObjects ??= objectsFromChain();
  for (const { table, sql } of chainObjects.values()) if (missing.has(table)) db.exec(sql);
}

// After the loop, when every column an index names exists; only a store missing one builds the chain.
export function ensureContinuityIndexes(db: DatabaseSyncLike): void {
  // SAFETY: one TEXT column named name.
  const present = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders(HEALED_INDEXES.length)})`)
    .all(...HEALED_INDEXES) as Array<{ name: string }>;
  if (present.length === HEALED_INDEXES.length) return;
  const have = new Set(present.map(({ name }) => name));
  chainObjects ??= objectsFromChain();
  for (const name of HEALED_INDEXES) {
    const made = chainObjects.get(name);
    if (!have.has(name) && made !== undefined && tableExists(db, made.table)) db.exec(made.sql);
  }
}

/** Each healed table's CREATE TABLE, then every index on it and on the request tables, keyed by object name, as the
 * migration chain leaves them on an empty database. */
function objectsFromChain(): ReadonlyMap<string, ChainObject> {
  const db = new DatabaseSync(':memory:');
  try {
    ensureMetaTable(db);
    // No root: only v39 reads it, to backfill rows an empty database does not have.
    for (const migration of MIGRATIONS) migration.up(db, {});
    const tables = [...HEALED_TABLES, ...REQUEST_TABLES];
    // SAFETY: rows follow the selected columns, and the WHERE drops the autoindexes whose sql is NULL.
    const rows = db
      .prepare(
        `SELECT name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index') ` +
          `AND tbl_name IN (${placeholders(tables.length)}) ORDER BY type DESC, name`,
      )
      .all(...tables) as Array<{ name: string; tbl_name: string; sql: string }>;
    return new Map(rows.map(({ name, tbl_name, sql }) => [name, { table: tbl_name, sql: ifNotExists(sql) }]));
  } finally {
    db.close();
  }
}

// sqlite_master keeps each CREATE without its IF NOT EXISTS.
const ifNotExists = (sql: string): string =>
  sql.replace(/^CREATE (UNIQUE )?(TABLE|INDEX) /, 'CREATE $1$2 IF NOT EXISTS ');
