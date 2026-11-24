import { DatabaseSync, type DatabaseSyncLike } from './sqlite.js';
import { ensureMetaTable } from './meta.js';
import { MIGRATIONS } from './migrations/index.js';
import { placeholders } from './sql.js';
import { tableExists } from './tables.js';

/** The session, card and quarantine tables a store can lose after its stamp passed their
 * migration. */
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

/** The indexes the chain puts on those tables and the two request indexes, by name: the open's
 * probe counts them, and a missing one is made again from the chain. */
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

/** The triggers the chain puts on those tables, by name: a dropped table takes its triggers with
 * it, so the open's probe counts them and a missing one is made again from the chain. */
export const HEALED_TRIGGERS = [
  'trg_task_snapshots_status_check_insert',
  'trg_task_snapshots_status_check_update',
] as const;

const HEALED_OBJECTS = [...HEALED_INDEXES, ...HEALED_TRIGGERS] as const;

const REQUEST_TABLES = ['compactions', 'failure_log'] as const;

interface ChainObject {
  readonly table: string;
  readonly sql: string;
}

let chainObjects: ReadonlyMap<string, ChainObject> | undefined;

/** The healed tables this store lacks; a read only, so an open can skip the write lock when none. */
export function missingHealedTables(db: DatabaseSyncLike): Set<string> {
  return new Set<string>(HEALED_TABLES.filter((table) => !tableExists(db, table)));
}

export function ensureContinuityTables(db: DatabaseSyncLike): void {
  const missing = missingHealedTables(db);
  if (missing.size === 0) return;
  chainObjects ??= objectsFromChain();
  for (const { table, sql } of chainObjects.values()) if (missing.has(table)) db.exec(sql);
}

export function ensureContinuityObjects(db: DatabaseSyncLike): void {
  // SAFETY: one TEXT column named name.
  const present = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') ` +
        `AND name IN (${placeholders(HEALED_OBJECTS.length)})`,
    )
    .all(...HEALED_OBJECTS) as Array<{ name: string }>;
  if (present.length === HEALED_OBJECTS.length) return;
  const have = new Set(present.map(({ name }) => name));
  chainObjects ??= objectsFromChain();
  for (const name of HEALED_OBJECTS) {
    const made = chainObjects.get(name);
    if (!have.has(name) && made !== undefined && tableExists(db, made.table)) db.exec(made.sql);
  }
}

function objectsFromChain(): ReadonlyMap<string, ChainObject> {
  const db = new DatabaseSync(':memory:');
  try {
    ensureMetaTable(db);
    for (const migration of MIGRATIONS) migration.up(db, {});
    const tables = [...HEALED_TABLES, ...REQUEST_TABLES];
    // SAFETY: rows follow the selected columns, and the WHERE drops the autoindexes whose sql is
    // NULL.
    const rows = db
      .prepare(
        `SELECT name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ` +
          `AND type IN ('table', 'index', 'trigger') AND tbl_name IN (${placeholders(tables.length)}) ` +
          `ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
      )
      .all(...tables) as Array<{ name: string; tbl_name: string; sql: string }>;
    return new Map(
      rows.map(({ name, tbl_name, sql }) => [name, { table: tbl_name, sql: ifNotExists(sql) }]),
    );
  } finally {
    db.close();
  }
}

const ifNotExists = (sql: string): string =>
  sql.replace(/^CREATE (UNIQUE )?(TABLE|INDEX|TRIGGER) /, 'CREATE $1$2 IF NOT EXISTS ');
