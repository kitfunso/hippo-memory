import type { DatabaseSyncLike } from '../db/index.js';

const STATEMENT_CACHE_MAX = 32;
const statementCache = new WeakMap<DatabaseSyncLike, Map<string, ReturnType<DatabaseSyncLike['prepare']>>>();

/** The hot read queries run on every request; keyed by handle, so a closed handle takes its statements along. */
export function cachedStatement(db: DatabaseSyncLike, sql: string): ReturnType<DatabaseSyncLike['prepare']> {
  let byText = statementCache.get(db);
  if (!byText) statementCache.set(db, (byText = new Map()));
  let stmt = byText.get(sql);
  if (!stmt) {
    // Tenant and scope clauses vary the text, so the cap keeps a long-lived handle from growing without bound.
    if (byText.size >= STATEMENT_CACHE_MAX) byText.clear();
    byText.set(sql, (stmt = db.prepare(sql)));
  }
  return stmt;
}
