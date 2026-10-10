/**
 * Dormant memories: what sleep does with a faded memory instead of deleting
 * it (config `dormant.enabled`, on by default; `retentionDays` bounds how
 * long one is kept).
 *
 * A dormant memory keeps its full content in `dormant_memories` (schema v44)
 * but is no longer a `memories` row, so recall, context, every sleep pass and
 * every other reader of `memories` stop seeing it exactly as if it had been
 * deleted. `hippo dormant` lists and searches them, `hippo dormant restore`
 * brings one back, `hippo dormant forget` deletes one for good.
 *
 * Not to be confused with the raw archive (`raw_archive`, `archiveRawMemory`,
 * `hippo forget --archive`): that path removes a raw receipt's content and
 * keeps only its metadata. A dormant memory keeps its content.
 *
 * The db-taking helpers leave the handle and any transaction to the caller.
 * The hippoRoot-taking functions at the end open one of their own, for
 * api.listDormant / restoreDormant / forgetDormant / isDormant.
 */
import { closeHippoDb, openHippoDb, withWriteScope, withWriteScopeOr, type DatabaseSyncLike } from '../db/index.js';
import { onHandle } from './open.js';
import type { MemoryEntry } from '../core/memory.js';
import type { SqlFragment } from './recall-scope.js';
import type { WriteBudget } from '../util/write-budget.js';
import { RejectedValueError, rejectionDigest } from './rejection.js';
import { escapeLike } from '../util/escape.js';
import { warnDamagedColumn } from '../util/stored-json.js';
import { DAY_MS } from '../util/time.js';
import { appendAuditEvent } from './audit.js';
import { audit, auditRejectionRefusal } from './audit-event.js';
import { entryIdTakenAt } from './entry-reads.js';
import { writeEntryDbOnly, writeEntryMirrors } from './entry-writes.js';

/** Why a memory went dormant: sleep's decay pass, an imported agent memory whose note was deleted, `hippo projects repair`
 * splitting a two-project merge, or `hippo audit repair` setting aside an automatic memory with a certain defect. */
export type DormantReason = 'decay' | 'source-deleted' | 'project-repair' | 'quality-repair';

/** One memory that sleep is moving out of active memory into the dormant store. */
export interface DormantMove {
  /** The memory as it stood when it faded; restored verbatim apart from its recall clock. */
  entry: MemoryEntry;
  /** Live strength at the moment it went dormant (below the decay threshold). */
  strength: number;
  reason: DormantReason;
  /** ISO time of the sleep that made it dormant. */
  dormantAt: string;
}

/** A dormant memory as listed to a user. */
export interface DormantMemory {
  id: string;
  tenantId: string;
  content: string;
  tags: string[];
  /** Live strength when it went dormant. */
  strength: number;
  /** Why it went dormant: one of the {@link DormantReason} values. */
  reason: string;
  /** ISO time it went dormant. */
  dormantAt: string;
}

/** Options for {@link listDormantRows}. */
export interface ListDormantOpts {
  /** Whitespace-separated terms; a row must contain every term (case-insensitive substring). */
  query?: string;
  /** Maximum rows returned, newest first. Default 20. */
  limit?: number;
}

interface DormantRow {
  tenant_id: string;
  id: string;
  content: string;
  entry_json: string;
  reason: string;
  strength: number;
  dormant_at: string;
}

const DEFAULT_LIST_LIMIT = 20;

/**
 * Insert (or refresh) the dormant snapshot for `move.entry`. Does not touch
 * the `memories` row: the caller deletes it in the same transaction, so the
 * memory is never in both places or in neither.
 */
export function insertDormantRow(db: DatabaseSyncLike, move: DormantMove): void {
  db.prepare(`
    INSERT INTO dormant_memories (tenant_id, id, content, entry_json, reason, strength, dormant_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, id) DO UPDATE SET
      content = excluded.content,
      entry_json = excluded.entry_json,
      reason = excluded.reason,
      strength = excluded.strength,
      dormant_at = excluded.dormant_at
  `).run(
    move.entry.tenantId,
    move.entry.id,
    move.entry.content,
    JSON.stringify(move.entry),
    move.reason,
    move.strength,
    move.dormantAt,
  );
}

/**
 * Parse a stored snapshot back into a MemoryEntry, or null when the row no
 * longer matches the snapshot it carries (edited by hand, or truncated).
 */
function parseSnapshot(row: DormantRow): MemoryEntry | null {
  try {
    // SAFETY: entry_json is only written by insertDormantRow from a MemoryEntry;
    // the id / tenant / content checks below reject a row edited out of shape.
    const entry = JSON.parse(row.entry_json) as MemoryEntry;
    if (entry.id !== row.id || entry.tenantId !== row.tenant_id || entry.content !== row.content) {
      return null;
    }
    return entry;
  } catch {
    // A row that will not parse is out of shape, so it is not restorable.
    warnDamagedColumn({ table: 'dormant_memories', id: row.id, column: 'entry_json' }, 'not valid JSON');
    return null;
  }
}

function rowToDormantMemory(row: DormantRow): DormantMemory {
  const entry = parseSnapshot(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    content: row.content,
    tags: entry && Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    strength: row.strength,
    reason: row.reason,
    dormantAt: row.dormant_at,
  };
}

// The snapshot's scope as a `scope` column, so recall-scope's SQL fragments read it as they read memories.scope.
const DORMANT_WITH_SCOPE = `(SELECT *, CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.scope') END AS scope FROM dormant_memories)`;
const EVERY_SCOPE: SqlFragment = { sql: '1', params: [] };

/** A tenant's dormant memories whose scope `admit` passes, newest first, optionally filtered by search terms. */
function listDormantRows(db: DatabaseSyncLike, tenantId: string, opts: ListDormantOpts = {}, admit: SqlFragment = EVERY_SCOPE): DormantMemory[] {
  const terms = (opts.query ?? '').trim().split(/\s+/).filter((t) => t.length > 0);
  const limit = opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit >= 1
    ? Math.floor(opts.limit)
    : DEFAULT_LIST_LIMIT;
  const termClauses = terms.map(() => ` AND content LIKE ? ESCAPE '\\'`).join('');
  // SAFETY: rows' shape matches the seven columns named in the SELECT.
  const rows = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM ${DORMANT_WITH_SCOPE}
      WHERE tenant_id = ? AND ${admit.sql}${termClauses}
      ORDER BY dormant_at DESC, id ASC
      LIMIT ?`,
  ).all(tenantId, ...admit.params, ...terms.map((t) => `%${escapeLike(t)}%`), limit) as DormantRow[];
  return rows.map(rowToDormantMemory);
}

/** A dormant memory's stored snapshot plus when and why it went dormant. */
export interface DormantSnapshot {
  entry: MemoryEntry;
  reason: string;
  strength: number;
  dormantAt: string;
}

/**
 * The stored snapshot for a tenant's dormant memory, or null when the tenant
 * has no dormant memory with that id (another tenant's id reads as absent).
 */
export function readDormantSnapshot(db: DatabaseSyncLike, tenantId: string, id: string): DormantSnapshot | null {
  // SAFETY: row's shape matches the seven columns named in the SELECT.
  const row = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM dormant_memories WHERE tenant_id = ? AND id = ?`,
  ).get(tenantId, id) as DormantRow | undefined;
  return row ? toSnapshot(row) : null;
}

/** Every dormant memory of a tenant whose snapshot still reads back. */
export function listDormantSnapshots(db: DatabaseSyncLike, tenantId: string): DormantSnapshot[] {
  // SAFETY: rows' shape matches the seven columns named in the SELECT.
  const rows = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM dormant_memories WHERE tenant_id = ?`,
  ).all(tenantId) as DormantRow[];
  return rows.flatMap((row) => toSnapshot(row) ?? []);
}

/** Readable snapshots whose entry's source starts with `prefix`; a malformed snapshot is passed over, not an error. */
export function dormantSnapshotsBySourcePrefix(db: DatabaseSyncLike, tenantId: string, prefix: string): DormantSnapshot[] {
  // SAFETY: rows' shape matches the seven columns named in the SELECT.
  const rows = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM dormant_memories
      WHERE tenant_id = ?
        AND CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.source') END LIKE ? ESCAPE '\\'`,
  ).all(tenantId, `${escapeLike(prefix)}%`) as DormantRow[];
  return rows.flatMap((row) => toSnapshot(row) ?? []).filter((s) => String(s.entry.source).startsWith(prefix));
}

function toSnapshot(row: DormantRow): DormantSnapshot | null {
  const entry = parseSnapshot(row);
  return entry ? { entry, reason: row.reason, strength: row.strength, dormantAt: row.dormant_at } : null;
}

/** Put `entry` in place of a tenant's dormant memory `id`, keeping when and why that one went dormant. */
export function replaceDormantEntry(db: DatabaseSyncLike, tenantId: string, id: string, entry: MemoryEntry): void {
  db.prepare(`UPDATE dormant_memories SET id = ?, content = ?, entry_json = ? WHERE tenant_id = ? AND id = ?`)
    .run(entry.id, entry.content, JSON.stringify(entry), tenantId, id);
}

/** Whether a tenant has a dormant memory with this id whose scope `admit` passes (snapshot readable or not). */
function hasDormantRow(db: DatabaseSyncLike, tenantId: string, id: string, admit: SqlFragment = EVERY_SCOPE): boolean {
  return db.prepare(`SELECT 1 FROM ${DORMANT_WITH_SCOPE} WHERE tenant_id = ? AND id = ? AND ${admit.sql}`).get(tenantId, id, ...admit.params) !== undefined;
}

/** Delete a tenant's dormant memory. Returns false when there was none. */
export function deleteDormantRow(db: DatabaseSyncLike, tenantId: string, id: string): boolean {
  const result = db.prepare(`DELETE FROM dormant_memories WHERE tenant_id = ? AND id = ?`).run(tenantId, id);
  return Number(result.changes ?? 0) > 0;
}

/** Deletes the tenant's dormant copies of a rejected digest whose snapshot scope `inReach` admits, so the value cannot linger; returns their ids. */
export function purgeDormantByDigest(
  db: DatabaseSyncLike, tenantId: string, digest: string, inReach: (scope: string | null) => boolean,
): string[] {
  // SAFETY: rows' shape matches the three columns named in the SELECT.
  const rows = db.prepare(
    `SELECT id, content, CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.scope') END AS scope
       FROM dormant_memories WHERE tenant_id = ?`,
  ).all(tenantId) as Array<{ id: string; content: string; scope: string | null }>;
  const removed: string[] = [];
  for (const row of rows) {
    if (rejectionDigest(row.content) !== digest || !inReach(row.scope)) continue;
    deleteDormantRow(db, tenantId, row.id);
    removed.push(row.id);
  }
  return removed;
}

interface DormantKey {
  readonly tenantId: string;
  readonly id: string;
}

function expiredDormantKeys(db: DatabaseSyncLike, cutoffIso: string): DormantKey[] {
  const sql = `SELECT tenant_id AS tenantId, id FROM dormant_memories WHERE dormant_at < ?`;
  // SAFETY: rows' shape matches the two columns named in the SELECT.
  return db.prepare(sql).all(cutoffIso) as DormantKey[];
}

function deleteExpiredDormantRow(db: DatabaseSyncLike, key: DormantKey, cutoffIso: string): number {
  const sql = `DELETE FROM dormant_memories WHERE tenant_id = ? AND id = ? AND dormant_at < ?`;
  return Number(db.prepare(sql).run(key.tenantId, key.id, cutoffIso).changes ?? 0);
}

/** Deletes `keys` in transactions of about `budget.holdMs`, letting other writers in between; returns how many went. */
async function expireInChunks(db: DatabaseSyncLike, keys: readonly DormantKey[], cutoffIso: string, budget: WriteBudget): Promise<number> {
  let gone = 0;
  let next = 0;
  let committedAt = 0;
  while (next < keys.length) {
    if (next > 0) await budget.pause(committedAt);
    withWriteScope(db, 'expire_dormant_chunk', () => {
      const begunAt = budget.clock();
      do gone += deleteExpiredDormantRow(db, keys[next++], cutoffIso);
      while (next < keys.length && budget.clock() - begunAt < budget.holdMs);
    });
    committedAt = budget.clock();
  }
  return gone;
}

/** Deletes for good every memory that went dormant before `cutoffIso`, on one handle; returns how many went, or under `dryRun` how many would. */
export async function expireDormantBefore(
  hippoRoot: string,
  cutoffIso: string,
  opts: { dryRun: boolean; budget: WriteBudget; busyWaitMs: number },
): Promise<number> {
  const db = openHippoDb(hippoRoot, { busyWaitMs: opts.busyWaitMs });
  try {
    // The keys come from a read, so a run with nothing to expire never takes the write lock.
    const keys = expiredDormantKeys(db, cutoffIso);
    return opts.dryRun ? keys.length : await expireInChunks(db, keys, cutoffIso, opts.budget);
  } finally {
    closeHippoDb(db);
  }
}

/** A tenant's dormant memories whose scope `admit` passes, newest first, read on a handle of its own. */
export function loadDormantMemories(hippoRoot: string, tenantId: string, opts: ListDormantOpts = {}, admit: SqlFragment = EVERY_SCOPE): DormantMemory[] {
  return onHandle(hippoRoot, (db) => {
    return listDormantRows(db, tenantId, opts, admit);
  });
}

/** Whether a tenant holds a dormant memory with this id whose scope `admit` passes, read on a handle of its own. */
export function holdsDormantMemory(hippoRoot: string, tenantId: string, id: string, admit: SqlFragment = EVERY_SCOPE): boolean {
  return onHandle(hippoRoot, (db) => {
    return hasDormantRow(db, tenantId, id, admit);
  });
}

/** One restore as the store applies it. The two functions are the caller's policy over plain rows; neither is handed the handle. */
export interface DormantRestore {
  readonly tenantId: string;
  readonly id: string;
  /** Who restores, for the audit rows. */
  readonly actor: string;
  /** False for a snapshot this caller may not touch, which then reads as missing. */
  readonly inReach: (scope: string | null) => boolean;
  /** The live memory the snapshot comes back as at `now`; a throw refuses before any write. */
  readonly revive: (snapshot: DormantSnapshot, now: Date) => MemoryEntry;
}

/** The restored memory, or why nothing was written: no dormant copy in reach, or a live memory already holds the id. */
export type DormantRestoreOutcome =
  | { readonly status: 'restored'; readonly entry: MemoryEntry }
  | { readonly status: 'missing' }
  | { readonly status: 'active' };

function auditDormantRestore(db: DatabaseSyncLike, restore: DormantRestore, snapshot: DormantSnapshot, now: Date): void {
  appendAuditEvent(db, {
    tenantId: restore.tenantId,
    actor: restore.actor,
    op: 'dormant_restore',
    targetId: restore.id,
    metadata: {
      reason: snapshot.reason,
      strengthAtDormancy: snapshot.strength,
      dormantAt: snapshot.dormantAt,
      daysDormant: Math.max(0, (now.getTime() - Date.parse(snapshot.dormantAt)) / DAY_MS),
    },
  });
}

function restoreInWriteScope(db: DatabaseSyncLike, restore: DormantRestore): DormantRestoreOutcome {
  return withWriteScopeOr<DormantRestoreOutcome, DormantRestoreOutcome>(db, 'restore_dormant', (rollback) => {
    const snapshot = readDormantSnapshot(db, restore.tenantId, restore.id);
    if (!snapshot || !restore.inReach(snapshot.entry.scope ?? null)) return rollback({ status: 'missing' });
    if (entryIdTakenAt(db, restore.id)) return rollback({ status: 'active' });
    const now = new Date();
    const entry = restore.revive(snapshot, now);
    writeEntryDbOnly(db, entry, { actor: restore.actor });
    deleteDormantRow(db, restore.tenantId, restore.id);
    // A restore is a labelled "forgot it, then needed it" event, the signal a learned lifecycle trains on.
    // Same write scope as the restore, so the label exists exactly when the restore does.
    auditDormantRestore(db, restore, snapshot, now);
    return { status: 'restored', entry };
  });
}

/** Brings one dormant memory back on a single handle: the live row, the dormant delete and the audit row commit together, then its mirrors are written. */
export function restoreDormantMemory(hippoRoot: string, restore: DormantRestore): DormantRestoreOutcome {
  return onHandle(hippoRoot, (db) => {
    let outcome: DormantRestoreOutcome;
    try {
      outcome = restoreInWriteScope(db, restore);
    } catch (error) {
      // Written after the rollback, so the refusal row outlives it.
      if (error instanceof RejectedValueError) auditRejectionRefusal(db, error, restore.actor);
      throw error;
    }
    if (outcome.status === 'restored') writeEntryMirrors(hippoRoot, outcome.entry);
    return outcome;
  });
}

/** One permanent delete of a dormant memory. */
export interface DormantForget {
  readonly tenantId: string;
  readonly id: string;
  /** Who forgets, for the audit row. */
  readonly actor: string;
  /** The scopes this caller may touch; a row outside them reads as missing. */
  readonly admit: SqlFragment;
}

/** Deletes a tenant's dormant memory for good and writes its `forget` audit row, on a single handle; false when it holds none `admit` passes. */
export function forgetDormantMemory(hippoRoot: string, forget: DormantForget): boolean {
  const { tenantId, id, actor, admit } = forget;
  return onHandle(hippoRoot, (db) => {
    if (!hasDormantRow(db, tenantId, id, admit) || !deleteDormantRow(db, tenantId, id)) return false;
    // Best-effort, like every other forget audit row: the delete stands.
    audit(db, 'forget', { tenantId, actor, targetId: id, metadata: { dormant: true } });
    return true;
  });
}
