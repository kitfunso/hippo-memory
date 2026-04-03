/**
 * Working Memory — bounded buffer for current-state notes.
 *
 * Separate from long-term semantic memory. Entries are scoped,
 * importance-ranked, and automatically evicted when the buffer
 * exceeds WM_MAX_ENTRIES per scope.
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { initStore } from './store.js';

export const WM_MAX_ENTRIES = 20;

export interface WorkingMemoryItem {
  id: number;
  scope: string;
  sessionId: string | null;
  taskId: string | null;
  importance: number;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

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
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    // malformed JSON — default to empty
  }
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

/**
 * Push a new entry into working memory.
 * If the scope exceeds WM_MAX_ENTRIES, the lowest-importance entry
 * is evicted (ties broken by oldest created_at).
 * Returns the new row ID.
 */
export function wmPush(hippoRoot: string, opts: {
  scope: string;
  content: string;
  importance?: number;
  sessionId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}): number {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const now = new Date().toISOString();
    const importance = opts.importance ?? 0;

    const result = db.prepare(`
      INSERT INTO working_memory(scope, session_id, task_id, importance, content, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.scope,
      opts.sessionId ?? null,
      opts.taskId ?? null,
      importance,
      opts.content,
      JSON.stringify(opts.metadata ?? {}),
      now,
      now,
    );

    const id = Number(result.lastInsertRowid ?? 0);

    // Evict if over capacity for this scope
    const countRow = db.prepare(`
      SELECT COUNT(*) AS cnt FROM working_memory WHERE scope = ?
    `).get(opts.scope) as { cnt: number } | undefined;

    const count = Number(countRow?.cnt ?? 0);
    if (count > WM_MAX_ENTRIES) {
      const excess = count - WM_MAX_ENTRIES;
      db.prepare(`
        DELETE FROM working_memory
        WHERE id IN (
          SELECT id FROM working_memory
          WHERE scope = ?
          ORDER BY importance ASC, created_at ASC
          LIMIT ?
        )
      `).run(opts.scope, excess);
    }

    return id;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Read working memory entries, sorted by importance DESC.
 */
export function wmRead(hippoRoot: string, opts?: {
  scope?: string;
  sessionId?: string;
  limit?: number;
}): WorkingMemoryItem[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (opts?.scope) {
      clauses.push('scope = ?');
      params.push(opts.scope);
    }
    if (opts?.sessionId) {
      clauses.push('session_id = ?');
      params.push(opts.sessionId);
    }

    const limit = Math.max(1, Math.trunc(opts?.limit ?? WM_MAX_ENTRIES));
    params.push(limit);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT id, scope, session_id, task_id, importance, content, metadata_json, created_at, updated_at
      FROM working_memory
      ${where}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(...params) as WorkingMemoryRow[];

    return rows.map(rowToItem);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Clear (delete) working memory entries. Returns the count deleted.
 */
export function wmClear(hippoRoot: string, opts?: {
  scope?: string;
  sessionId?: string;
}): number {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (opts?.scope) {
      clauses.push('scope = ?');
      params.push(opts.scope);
    }
    if (opts?.sessionId) {
      clauses.push('session_id = ?');
      params.push(opts.sessionId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = db.prepare(`DELETE FROM working_memory ${where}`).run(...params);
    return Number(result.changes ?? 0);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Flush working memory — delete entries after session end.
 * Functionally identical to wmClear but semantically distinct:
 * used at session boundaries to discard ephemeral state.
 * Returns the count flushed.
 */
export function wmFlush(hippoRoot: string, opts?: {
  scope?: string;
  sessionId?: string;
}): number {
  return wmClear(hippoRoot, opts);
}
