// The GitHub connector's tables: event log, dead-letter queue, tenant routing and backfill cursors.

import { withWriteScope, type DatabaseSyncLike } from '../../db.js';
import { archiveRawMemory } from '../../raw-archive.js';
import { onHandle } from '../open.js';

/** One github_event_log row to write; `memoryId` is null for an event that produced no memory. */
export interface GithubEventLogEntry {
  idempotencyKey: string;
  deliveryId: string;
  eventName: string;
  memoryId: string | null;
}

export function eventSeenAt(db: DatabaseSyncLike, idempotencyKey: string): boolean {
  const row = db.prepare(`SELECT 1 FROM github_event_log WHERE idempotency_key = ?`).get(idempotencyKey);
  return !!row;
}

export function eventMemoryAt(db: DatabaseSyncLike, idempotencyKey: string): string | null {
  // SAFETY: the SELECT projects exactly the memory_id column of github_event_log.
  const row = db.prepare(`SELECT memory_id FROM github_event_log WHERE idempotency_key = ?`).get(idempotencyKey) as
    | { memory_id: string | null }
    | undefined;
  return row?.memory_id ?? null;
}

/** False when the key was already logged, so a caller inside a write scope can roll its own row back. */
export function logEventAt(db: DatabaseSyncLike, entry: GithubEventLogEntry): boolean {
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(entry.idempotencyKey, entry.deliveryId, entry.eventName, new Date().toISOString(), entry.memoryId);
  return Number(inserted.changes ?? 0) !== 0;
}

/** The memory an already-seen key points at, or null when the key is new. */
export function seenEvent(hippoRoot: string, idempotencyKey: string): { memoryId: string | null } | null {
  return onHandle(hippoRoot, (db) =>
    eventSeenAt(db, idempotencyKey) ? { memoryId: eventMemoryAt(db, idempotencyKey) } : null);
}

export function eventMemory(hippoRoot: string, idempotencyKey: string): string | null {
  return onHandle(hippoRoot, (db) => eventMemoryAt(db, idempotencyKey));
}

export function logEvent(hippoRoot: string, entry: GithubEventLogEntry): void {
  onHandle(hippoRoot, (db) => { logEventAt(db, entry); });
}

export interface ArtifactDeletion {
  tenantId: string;
  artifactRef: string;
  idempotencyKey: string;
  deliveryId: string;
  eventName: string;
  reason: string;
  who: string;
}

/** Archives every active raw row of one tenant's artifact and logs the delete event; a failed archive rolls back the batch and the log row. */
export function archiveDeletedArtifact(hippoRoot: string, del: ArtifactDeletion): { duplicate: boolean; archived: number } {
  return onHandle(hippoRoot, (db) => {
    if (eventSeenAt(db, del.idempotencyKey)) return { duplicate: true, archived: 0 };
    const logged = { idempotencyKey: del.idempotencyKey, deliveryId: del.deliveryId, eventName: del.eventName };

    // SAFETY: the SELECT projects only the `id` column.
    const rows = db
      .prepare(
        `SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`,
      )
      .all(del.artifactRef, del.tenantId) as Array<{ id: string }>;
    const memoryIds = rows.map((r) => r.id);

    if (memoryIds.length === 0) {
      // Still logged, so a retry of the same delete answers 'duplicate'.
      logEventAt(db, { ...logged, memoryId: null });
      return { duplicate: false, archived: 0 };
    }

    withWriteScope(db, 'github_delete_all', () => {
      for (const id of memoryIds) archiveRawMemory(db, id, { reason: del.reason, who: del.who });
      logEventAt(db, { ...logged, memoryId: memoryIds[0]! });
    });
    return { duplicate: false, archived: memoryIds.length };
  });
}

export type DlqBucket = 'parse_error' | 'unroutable' | 'signature_failed' | 'unhandled';

export interface DlqItem {
  id: number;
  tenantId: string;
  rawPayload: string;
  error: string;
  eventName: string | null;
  deliveryId: string | null;
  signature: string | null;
  installationId: string | null;
  repoFullName: string | null;
  retryCount: number;
  receivedAt: string;
  retriedAt: string | null;
  bucket: DlqBucket | string;
}

/** One github_dlq row to write, already redacted by the caller; the four GitHub-only columns are stored NULL when left out. */
export interface GithubDlqWrite {
  tenantId: string;
  rawPayload: string;
  error: string;
  eventName?: string | null;
  deliveryId?: string | null;
  signature: string | null;
  installationId?: string | null;
  repoFullName?: string | null;
  bucket: DlqBucket;
}

function insertDlqAt(db: DatabaseSyncLike, row: GithubDlqWrite): number {
  const result = db
    .prepare(
      `INSERT INTO github_dlq
        (tenant_id, raw_payload, error, event_name, delivery_id, signature,
         installation_id, repo_full_name, received_at, bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.tenantId,
      row.rawPayload,
      row.error,
      row.eventName ?? null,
      row.deliveryId ?? null,
      row.signature,
      row.installationId ?? null,
      row.repoFullName ?? null,
      new Date().toISOString(),
      row.bucket,
    );
  return Number(result.lastInsertRowid);
}

export function insertDlq(hippoRoot: string, row: GithubDlqWrite): number {
  return onHandle(hippoRoot, (db) => insertDlqAt(db, row));
}

const SELECT_COLUMNS = `id, tenant_id, raw_payload, error, event_name, delivery_id,
            signature, installation_id, repo_full_name, retry_count,
            received_at, retried_at, bucket`;

// The driver returns each column by its stored affinity; rowToItem coerces every field, so a named union is contract enough.
type DlqRawRow = {
  id: string | number | bigint;
  tenant_id: string | number | bigint | null;
  raw_payload: string | number | bigint | null;
  error: string | number | bigint | null;
  event_name: string | number | bigint | null;
  delivery_id: string | number | bigint | null;
  signature: string | number | bigint | null;
  installation_id: string | number | bigint | null;
  repo_full_name: string | number | bigint | null;
  retry_count: string | number | bigint | null;
  received_at: string | number | bigint | null;
  retried_at: string | number | bigint | null;
  bucket: string | number | bigint | null;
};

function rowToItem(r: DlqRawRow): DlqItem {
  return {
    id: Number(r.id),
    tenantId: String(r.tenant_id),
    rawPayload: String(r.raw_payload),
    error: String(r.error),
    eventName: r.event_name == null ? null : String(r.event_name),
    deliveryId: r.delivery_id == null ? null : String(r.delivery_id),
    signature: r.signature == null ? null : String(r.signature),
    installationId: r.installation_id == null ? null : String(r.installation_id),
    repoFullName: r.repo_full_name == null ? null : String(r.repo_full_name),
    retryCount: Number(r.retry_count ?? 0),
    receivedAt: String(r.received_at),
    retriedAt: r.retried_at == null ? null : String(r.retried_at),
    bucket: r.bucket == null ? 'parse_error' : String(r.bucket),
  };
}

function listDlqAt(db: DatabaseSyncLike, tenantId: string, limit: number): DlqItem[] {
  // SAFETY: SELECT_COLUMNS projects exactly DlqRawRow's fields.
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM github_dlq
        WHERE tenant_id = ?
        ORDER BY received_at ASC
        LIMIT ?`,
    )
    .all(tenantId, limit) as DlqRawRow[];
  return rows.map(rowToItem);
}

export function listDlqRows(hippoRoot: string, tenantId: string, limit: number): DlqItem[] {
  return onHandle(hippoRoot, (db) => listDlqAt(db, tenantId, limit));
}

function dlqEntryAt(db: DatabaseSyncLike, id: number): DlqItem | null {
  // SAFETY: SELECT_COLUMNS projects exactly DlqRawRow's fields.
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM github_dlq
        WHERE id = ?`,
    )
    .get(id) as DlqRawRow | undefined;
  if (!row) return null;
  return rowToItem(row);
}

export function dlqEntry(hippoRoot: string, id: number): DlqItem | null {
  return onHandle(hippoRoot, (db) => dlqEntryAt(db, id));
}

export function bumpDlqRetry(hippoRoot: string, id: number): void {
  onHandle(hippoRoot, (db) => {
    db.prepare(
      `UPDATE github_dlq
          SET retry_count = retry_count + 1,
              retried_at = ?
        WHERE id = ?`,
    ).run(new Date().toISOString(), id);
  });
}

/** What the routing tables say about one webhook; `tenant` is the installation match, or the repo match when no installation was sent. */
export interface GithubRouting {
  installations: number;
  repositories: number;
  tenant: string | null;
}

export function githubRouting(
  hippoRoot: string,
  args: { installationId?: string | null; repoFullName?: string | null },
): GithubRouting {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: the SELECT projects exactly one column, `c`, as a COUNT(*).
    const instCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM github_installations`)
      .get() as { c: number | bigint }).c;
    // SAFETY: the SELECT projects exactly one column, `c`, as a COUNT(*).
    const repoCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM github_repositories`)
      .get() as { c: number | bigint }).c;
    const counts = { installations: Number(instCount), repositories: Number(repoCount) };

    if (args.installationId) {
      // SAFETY: the SELECT projects exactly the tenant_id column of github_installations.
      const row = db
        .prepare(`SELECT tenant_id FROM github_installations WHERE installation_id = ?`)
        .get(args.installationId) as { tenant_id?: string } | undefined;
      return { ...counts, tenant: row?.tenant_id ?? null };
    }
    if ((counts.installations === 0 && counts.repositories === 0) || !args.repoFullName) {
      return { ...counts, tenant: null };
    }
    // SAFETY: the SELECT projects exactly the tenant_id column of github_repositories.
    const row = db
      .prepare(
        `SELECT tenant_id FROM github_repositories WHERE repo_full_name = ? ORDER BY added_at, tenant_id LIMIT 1`,
      )
      .get(args.repoFullName) as { tenant_id?: string } | undefined;
    return { ...counts, tenant: row?.tenant_id ?? null };
  });
}

export type HwmColumn = 'issues_hwm' | 'issue_comments_hwm' | 'pr_review_comments_hwm';

export interface StoredCursors {
  issues: string | null;
  issueComments: string | null;
  prReviewComments: string | null;
}

export function readCursors(hippoRoot: string, tenantId: string, repo: string): StoredCursors {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: the SELECT names exactly the three HWM columns.
    const row = db
      .prepare(
        `SELECT issues_hwm, issue_comments_hwm, pr_review_comments_hwm
         FROM github_cursors WHERE tenant_id = ? AND repo_full_name = ?`,
      )
      .get(tenantId, repo) as
      | {
          issues_hwm?: string | null;
          issue_comments_hwm?: string | null;
          pr_review_comments_hwm?: string | null;
        }
      | undefined;
    return {
      issues: row?.issues_hwm ?? null,
      issueComments: row?.issue_comments_hwm ?? null,
      prReviewComments: row?.pr_review_comments_hwm ?? null,
    };
  });
}

export function writeHwm(hippoRoot: string, tenantId: string, repo: string, column: HwmColumn, value: string): void {
  onHandle(hippoRoot, (db) => {
    db.prepare(
      `INSERT INTO github_cursors (tenant_id, repo_full_name, ${column}, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, repo_full_name)
       DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`,
    ).run(tenantId, repo, value, new Date().toISOString());
  });
}

/** Sets all three HWMs to `since` for a first run; COALESCE keeps any HWM a stream has already saved. */
export function seedCursors(hippoRoot: string, tenantId: string, repo: string, since: string): void {
  onHandle(hippoRoot, (db) => {
    db.prepare(
      `INSERT INTO github_cursors (tenant_id, repo_full_name, issues_hwm, issue_comments_hwm, pr_review_comments_hwm, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, repo_full_name) DO UPDATE SET
           issues_hwm = COALESCE(github_cursors.issues_hwm, excluded.issues_hwm),
           issue_comments_hwm = COALESCE(github_cursors.issue_comments_hwm, excluded.issue_comments_hwm),
           pr_review_comments_hwm = COALESCE(github_cursors.pr_review_comments_hwm, excluded.pr_review_comments_hwm),
           updated_at = excluded.updated_at`,
    ).run(tenantId, repo, since, since, since, new Date().toISOString());
  });
}
