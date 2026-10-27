// hippo.db's working memory rows: a bounded buffer per scope, apart from long-term memory.
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type {
  WorkingMemoryItem,
  WorkingMemoryFilter,
  WorkingMemoryPush,
} from '../../base/ports/store/sessions.js';
import type { JsonObject } from '../../base/util/json.js';
import { parseStoredObject } from '../../base/util/stored-json.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { WM_MAX_ENTRIES } from '../../base/util/limits.js';
import { handleStamp } from './handle-clock.js';
/** Working Memory: bounded buffer for current-state notes, separate from long-term memory;
 * scoped, importance-ranked, evicted past WM_MAX_ENTRIES per scope. */

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface WorkingMemoryRow {
  id: number;
  scope: string;
  session_id: string | null;
  task_id: string | null;
  importance: number;
  content: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: WorkingMemoryRow): WorkingMemoryItem {
  // Damaged metadata logs once and reads as empty: the item still lists with its content.
  const metadata: JsonObject =
    parseStoredObject(
      { table: 'working_memory', id: row.id, column: 'metadata_json' },
      row.metadata_json,
    ) ?? {};
  return {
    id: row.id,
    scope: row.scope,
    sessionId: row.session_id,
    taskId: row.task_id,
    importance: Number(row.importance),
    content: row.content,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Push a new entry into working memory; past WM_MAX_ENTRIES the scope's lowest-importance entry
 * is evicted (ties: the oldest, by created_at then id). Returns the new row ID. */
export function wmPush(db: DatabaseSyncLike, tenantId: string, item: WorkingMemoryPush): number {
  const now = handleStamp(db);
  return withWriteScope(db, 'wm_push', () => {
    const result = cachedStatement(
      db,
      `
      INSERT INTO working_memory(scope, session_id, task_id, importance, content, metadata_json, created_at,
      updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      item.scope,
      item.sessionId ?? null,
      item.taskId ?? null,
      item.importance ?? 0,
      item.content,
      JSON.stringify(item.metadata ?? {}),
      now,
      now,
      tenantId,
    );

    const id = Number(result.lastInsertRowid ?? 0);

    evictOverCapacity(db, item.scope, tenantId);

    return id;
  });
}

function evictOverCapacity(db: DatabaseSyncLike, scope: string, tenantId: string): void {
  // Evict if over capacity for this scope.
  const countRow = cachedStatement(
    db,
    `
    SELECT COUNT(*) AS cnt FROM working_memory WHERE scope = ? AND tenant_id = ?
  `,
  ).get(scope, tenantId) as { cnt: number } | undefined;

  const count = Number(countRow?.cnt ?? 0);
  if (count > WM_MAX_ENTRIES) {
    const excess = count - WM_MAX_ENTRIES;
    cachedStatement(
      db,
      `
      DELETE FROM working_memory
      WHERE id IN (
        SELECT id FROM working_memory
        WHERE scope = ? AND tenant_id = ?
        ORDER BY importance ASC, created_at ASC, id ASC
        LIMIT ?
      )
    `,
    ).run(scope, tenantId, excess);
  }
}

/** The WHERE clause and arguments that narrow working memory to one tenant and, when set, a
 * scope and a session. */
function wmWhere(tenantId: string, filter: WorkingMemoryFilter) {
  const clauses = ['tenant_id = ?'];
  const params = [tenantId];
  if (filter.scope) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.sessionId) {
    clauses.push('session_id = ?');
    params.push(filter.sessionId);
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

/** Read working memory entries, sorted by importance DESC. */
export function wmRead(
  db: DatabaseSyncLike,
  tenantId: string,
  filter: WorkingMemoryFilter & { readonly limit?: number },
): WorkingMemoryItem[] {
  const where = wmWhere(tenantId, filter);
  const limit = Math.max(1, Math.trunc(filter.limit ?? WM_MAX_ENTRIES));
  const rows = cachedStatement(
    db,
    `
    SELECT id, scope, session_id, task_id, importance, content, metadata_json, created_at, updated_at
    FROM working_memory
    ${where.sql}
    ORDER BY importance DESC, created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(...where.params, limit) as WorkingMemoryRow[];

  return rows.map(rowToItem);
}

/** Clear (delete) working memory entries. Returns the count deleted. */
export function wmClear(
  db: DatabaseSyncLike,
  tenantId: string,
  filter: WorkingMemoryFilter,
): number {
  const where = wmWhere(tenantId, filter);
  const result = cachedStatement(db, `DELETE FROM working_memory ${where.sql}`).run(
    ...where.params,
  );
  return Number(result.changes ?? 0);
}
