// The `compactions` table: one row per Claude Code compaction, and the reads project merge makes over it.
import type { DatabaseSyncLike } from '../db/index.js';
import { originInSql } from '../core/project-identity.js';
import { scopeAdmitSql } from './rule-sql.js';

export type CompactionStatus = 'started' | 'summarised' | 'done' | 'no-summary';

export interface CompactionRow {
  tenant_id: string;
  id: string;
  session_id: string;
  origin_project: string;
  compact_trigger: string | null;
  cwd: string | null;
  transcript_path: string | null;
  snapshot_saved: number;
  started_at: string;
  summarised_at: string | null;
  summary: string | null;
  items_json: string | null;
  items_written: number;
  status: CompactionStatus;
}

export interface HeldMemoryRow {
  id: string;
  source_session_id: string | null;
  content: string;
}

export interface StartedCompactionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly originProject: string;
  readonly trigger: string | null;
  readonly cwd: string | null;
  readonly transcriptPath: string | null;
  readonly startedAt: string;
}

export interface SummarisedUpdate {
  readonly summary: string;
  readonly itemsJson: string;
  readonly summarisedAt: string;
  readonly requestId?: string;
}

export interface SummarisedInsert extends SummarisedUpdate {
  readonly id: string;
}

export type SummarisedInsertMeta = Omit<StartedCompactionInput, 'id'>;

const COLUMNS = 'tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, snapshot_saved, started_at, summarised_at, summary, ' +
  'items_json, items_written, status';

function selectRows(db: DatabaseSyncLike, where: string, ...params: Array<string | number>): CompactionRow[] {
  // SAFETY: the SELECT names exactly COLUMNS, matching CompactionRow's field set.
  return db.prepare(`SELECT ${COLUMNS} FROM compactions WHERE ${where}`).all(...params) as CompactionRow[];
}

/** A session's newest row, as an array of at most one. */
export function latestCompactionRows(db: DatabaseSyncLike, tenantId: string, sessionId: string): CompactionRow[] {
  return selectRows(db, 'tenant_id = ? AND session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', tenantId, sessionId);
}

export function compactionRowsByRequest(db: DatabaseSyncLike, tenantId: string, requestId: string): CompactionRow[] {
  return selectRows(db, 'tenant_id = ? AND request_id = ?', tenantId, requestId);
}

/** The session's newest `started` row with a start in [`notBefore`, `notAfter`], both ISO strings. */
export function latestStartedRows(db: DatabaseSyncLike, tenantId: string, sessionId: string, notAfter: string, notBefore: string): CompactionRow[] {
  return selectRows(
    db,
    `tenant_id = ? AND session_id = ? AND status = 'started' AND started_at <= ? AND started_at >= ? ORDER BY started_at DESC, id DESC LIMIT 1`,
    tenantId,
    sessionId,
    notAfter,
    notBefore,
  );
}

/** `summarised` rows whose summary is older than `summarisedBefore`, an ISO string. */
export function stalledSummarisedRows(db: DatabaseSyncLike, tenantId: string, summarisedBefore: string): CompactionRow[] {
  return selectRows(db, `tenant_id = ? AND status = 'summarised' AND summarised_at < ?`, tenantId, summarisedBefore);
}

/** `started` rows with a transcript whose start lies between `startedAfter` and `startedBefore`, oldest first. */
export function openTranscriptRows(db: DatabaseSyncLike, tenantId: string, startedBefore: string, startedAfter: string): CompactionRow[] {
  return selectRows(
    db,
    `tenant_id = ? AND status = 'started' AND started_at < ? AND started_at > ? AND transcript_path IS NOT NULL ORDER BY started_at`,
    tenantId,
    startedBefore,
    startedAfter,
  );
}

export function insertStartedCompaction(db: DatabaseSyncLike, tenantId: string, start: StartedCompactionInput): void {
  db.prepare(
    `INSERT INTO compactions(tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(tenantId, start.id, start.sessionId, start.originProject, start.trigger, start.cwd, start.transcriptPath, start.startedAt);
}

/** Moves a `started` row to `summarised`; false when another process already moved it. */
export function markCompactionSummarised(db: DatabaseSyncLike, tenantId: string, id: string, update: SummarisedUpdate): boolean {
  const { summary, itemsJson, summarisedAt, requestId } = update;
  // Only a caller names the column, so a store from before it was added still takes local writes.
  const stamp = requestId === undefined ? [] : [requestId];
  const result = db.prepare(
    `UPDATE compactions SET summary = ?, items_json = ?, summarised_at = ?, status = 'summarised'${stamp.length === 0 ? '' : ', request_id = ?'}
     WHERE tenant_id = ? AND id = ? AND status = 'started'`,
  ).run(summary, itemsJson, summarisedAt, ...stamp, tenantId, id);
  return (result.changes ?? 0) > 0;
}

export function insertSummarisedCompaction(db: DatabaseSyncLike, tenantId: string, meta: SummarisedInsertMeta, row: SummarisedInsert): void {
  const { id, summary, itemsJson, summarisedAt, requestId } = row;
  // Only a caller names the column, so a store from before it was added still takes local writes.
  const stamp = requestId === undefined ? [] : [requestId];
  const [col, mark] = stamp.length === 0 ? ['', ''] : [', request_id', ', ?'];
  db.prepare(
    `INSERT INTO compactions(tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, started_at, summarised_at, summary, items_json, status${col})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'summarised'${mark})`,
  ).run(
    tenantId,
    id,
    meta.sessionId,
    meta.originProject,
    meta.trigger,
    meta.cwd,
    meta.transcriptPath,
    meta.startedAt,
    summarisedAt,
    summary,
    itemsJson,
    ...stamp
  );
}

export function markSnapshotSavedRow(db: DatabaseSyncLike, tenantId: string, recordId: string): void {
  db.prepare(`UPDATE compactions SET snapshot_saved = 1 WHERE tenant_id = ? AND id = ?`).run(tenantId, recordId);
}

export function compactionProgress(db: DatabaseSyncLike, tenantId: string, id: string): { status: CompactionStatus; items_written: number } | undefined {
  return db.prepare(`SELECT status, items_written FROM compactions WHERE tenant_id = ? AND id = ?`)
    .get<{ status: CompactionStatus; items_written: number } | undefined>(tenantId, id);
}

export function markCompactionDone(db: DatabaseSyncLike, tenantId: string, id: string, itemsWritten: number): void {
  db.prepare(`UPDATE compactions SET items_written = ?, status = 'done' WHERE tenant_id = ? AND id = ?`).run(itemsWritten, tenantId, id);
}

/** Rows changed: 1 when the `started` row was closed, 0 when it had already moved. */
export function closeStartedWithoutSummary(db: DatabaseSyncLike, tenantId: string, id: string): number {
  const result = db.prepare(`UPDATE compactions SET status = 'no-summary' WHERE tenant_id = ? AND id = ? AND status = 'started'`).run(tenantId, id);
  return Number(result.changes ?? 0);
}

export function nextCompactionStart(db: DatabaseSyncLike, tenantId: string, sessionId: string, after: string): string | null {
  const row = db.prepare(`SELECT MIN(started_at) AS at FROM compactions WHERE tenant_id = ? AND session_id = ? AND started_at > ?`)
    .get<{ at: string | null } | undefined>(tenantId, sessionId, after);
  return row?.at ?? null;
}

/** Live rows of one tenant and origin set that default recall shows. */
export function heldMemoryRows(db: DatabaseSyncLike, tenantId: string, origins: readonly string[]): HeldMemoryRow[] {
  const deny = scopeAdmitSql('');
  // SAFETY: the SELECT names the id, source_session_id and content columns.
  return db.prepare(
    `SELECT id, source_session_id, content FROM memories WHERE tenant_id = ? AND ${originInSql(origins)} AND superseded_by IS NULL AND kind != 'raw'
       AND ${deny.sql}`,
  ).all(tenantId, ...origins, ...deny.params) as HeldMemoryRow[];
}

export function restampCompactionOrigin(db: DatabaseSyncLike, tenantId: string, from: string, into: string): number {
  return Number(db.prepare(`UPDATE compactions SET origin_project = ? WHERE tenant_id = ? AND origin_project = ?`)
    .run(into, tenantId, from).changes ?? 0);
}

export function compactionTranscripts(db: DatabaseSyncLike, tenantId: string): Array<{ transcript: string; cwd: string | null }> {
  // SAFETY: the SELECT names the two columns of the row type.
  return db.prepare(`SELECT DISTINCT transcript_path AS transcript, cwd FROM compactions WHERE tenant_id = ? AND transcript_path IS NOT NULL`)
    .all(tenantId) as Array<{ transcript: string; cwd: string | null }>;
}

export function compactionOriginsWithCwd(db: DatabaseSyncLike, tenantId: string): Array<{ origin: string; cwd: string }> {
  // SAFETY: the SELECT names the two columns of the row type.
  return db.prepare(`SELECT DISTINCT origin_project AS origin, cwd FROM compactions WHERE tenant_id = ? AND origin_project <> '' AND cwd IS NOT NULL`)
    .all(tenantId) as Array<{ origin: string; cwd: string }>;
}

/** True when `table` holds a row of this tenant under the project name. */
export function holdsOrigin(db: DatabaseSyncLike, table: 'memories' | 'compactions', tenantId: string, name: string): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND origin_project = ? LIMIT 1`).get(tenantId, name) !== undefined;
}
