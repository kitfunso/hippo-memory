import type { DatabaseSyncLike } from '../db/index.js';

const STATEMENT_CACHE_MAX = 32;
const statementCache = new WeakMap<DatabaseSyncLike, Map<string, ReturnType<DatabaseSyncLike['prepare']>>>();

/** Statements run per request or per row, prepared once per handle; keyed by handle, so a closed handle takes its
 * statements along. */
export function cachedStatement(db: DatabaseSyncLike, sql: string): ReturnType<DatabaseSyncLike['prepare']> {
  let byText = statementCache.get(db);
  if (!byText) statementCache.set(db, (byText = new Map()));
  let stmt = byText.get(sql);
  if (stmt) {
    // A Map keeps insertion order, so a hit moved to the end leaves the least recently used statement first.
    byText.delete(sql);
  } else {
    stmt = db.prepare(sql);
    // Tenant and scope clauses vary the text, so the cap keeps a long-lived handle from growing without bound.
    if (byText.size >= STATEMENT_CACHE_MAX) byText.delete(byText.keys().next().value!);
  }
  byText.set(sql, stmt);
  return stmt;
}
