// The GitHub connector's tables: event log, dead-letter queue, tenant routing and backfill cursors.

import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { archiveRawMemory } from '../raw-archive.js';
import { onHandle } from '../open.js';
import type { ConnectorEventRecord } from '../port.js';
import { eventMemoryAt, eventRecord, eventSeenAt, markEventSeenAt, type EventLogSpec } from './event-log.js';
import { dlqAccess } from './dlq.js';

/** One github_event_log row to write; `memoryId` is null for an event that produced no memory. */
export interface GitHubEventLogEntry {
  idempotencyKey: string;
  deliveryId: string;
  eventName: string;
  memoryId: string | null;
}

const GITHUB_LOG: EventLogSpec = { table: 'github_event_log', keyColumn: 'idempotency_key' };

export function githubEventSeenAt(db: DatabaseSyncLike, idempotencyKey: string): boolean {
  return eventSeenAt(db, GITHUB_LOG, idempotencyKey);
}

export function githubEventMemoryAt(db: DatabaseSyncLike, idempotencyKey: string): string | null {
  return eventMemoryAt(db, GITHUB_LOG, idempotencyKey);
}

/** False when the key was already logged, so a caller inside a write scope can roll its own row back. */
export function markGitHubEventSeenAt(db: DatabaseSyncLike, entry: GitHubEventLogEntry): boolean {
  return markEventSeenAt(
    db, GITHUB_LOG, entry.idempotencyKey,
    [['delivery_id', entry.deliveryId], ['event_name', entry.eventName]], entry.memoryId,
  );
}

export function githubEventRecord(hippoRoot: string, idempotencyKey: string): ConnectorEventRecord {
  return eventRecord(hippoRoot, GITHUB_LOG, idempotencyKey);
}

export function markGitHubEventSeen(hippoRoot: string, entry: GitHubEventLogEntry): void {
  onHandle(hippoRoot, (db) => { markGitHubEventSeenAt(db, entry); });
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

/** Archives every active raw row of one tenant's artifact and logs the delete event; a failed archive rolls back the
 * batch and the log row. */
export function archiveDeletedArtifact(
  hippoRoot: string,
  del: ArtifactDeletion,
): { duplicate: boolean; archived: number } {
  return onHandle(hippoRoot, (db) => {
    if (githubEventSeenAt(db, del.idempotencyKey)) return { duplicate: true, archived: 0 };
    const logged = { idempotencyKey: del.idempotencyKey, deliveryId: del.deliveryId, eventName: del.eventName };

    // SAFETY: the SELECT projects only the `id` column.
    const rows = db
      .prepare(`SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`)
      .all(del.artifactRef, del.tenantId) as Array<{ id: string }>;
    const memoryIds = rows.map((r) => r.id);

    if (memoryIds.length === 0) {
      // Still logged, so a retry of the same delete answers 'duplicate'.
      markGitHubEventSeenAt(db, { ...logged, memoryId: null });
      return { duplicate: false, archived: 0 };
    }

    withWriteScope(db, 'github_delete_all', () => {
      for (const id of memoryIds) archiveRawMemory(db, id, { reason: del.reason, who: del.who });
      markGitHubEventSeenAt(db, { ...logged, memoryId: memoryIds[0]! });
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

/** One github_dlq row to write, already redacted by the caller; the four GitHub-only columns are stored NULL when left
 * out. */
export interface GitHubDlqInsert {
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

const DLQ = dlqAccess<DlqItem, GitHubDlqInsert>('github_dlq', [
  { field: 'id', column: 'id', kind: 'int' },
  { field: 'tenantId', column: 'tenant_id', kind: 'text', insert: true },
  { field: 'rawPayload', column: 'raw_payload', kind: 'text', insert: true },
  { field: 'error', column: 'error', kind: 'text', insert: true },
  { field: 'eventName', column: 'event_name', kind: 'nullableText', insert: true },
  { field: 'deliveryId', column: 'delivery_id', kind: 'nullableText', insert: true },
  { field: 'signature', column: 'signature', kind: 'nullableText', insert: true },
  { field: 'installationId', column: 'installation_id', kind: 'nullableText', insert: true },
  { field: 'repoFullName', column: 'repo_full_name', kind: 'nullableText', insert: true },
  { field: 'retryCount', column: 'retry_count', kind: 'count' },
  { field: 'receivedAt', column: 'received_at', kind: 'text' },
  { field: 'retriedAt', column: 'retried_at', kind: 'nullableText' },
  { field: 'bucket', column: 'bucket', kind: 'bucket', insert: true },
]);

export function insertGitHubDlq(hippoRoot: string, row: GitHubDlqInsert): number {
  return onHandle(hippoRoot, (db) => DLQ.insert(db, row));
}

export function listGitHubDlq(hippoRoot: string, tenantId: string, limit: number): DlqItem[] {
  return onHandle(hippoRoot, (db) => DLQ.list(db, tenantId, limit));
}

export function githubDlqEntry(hippoRoot: string, id: number): DlqItem | null {
  return onHandle(hippoRoot, (db) => DLQ.get(db, id));
}

export function markGitHubDlqRetried(hippoRoot: string, id: number): void {
  onHandle(hippoRoot, (db) => DLQ.markRetried(db, id));
}

/** What the routing tables say about one webhook; `tenant` is the installation match, or the repo match when no
 * installation was sent. */
export interface GitHubRouting {
  installations: number;
  repositories: number;
  tenant: string | null;
}

export function githubRouting(
  hippoRoot: string,
  args: { installationId?: string | null; repoFullName?: string | null },
): GitHubRouting {
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
      `INSERT INTO github_cursors (tenant_id, repo_full_name, issues_hwm, issue_comments_hwm, ` +
      `pr_review_comments_hwm, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, repo_full_name) DO UPDATE SET
           issues_hwm = COALESCE(github_cursors.issues_hwm, excluded.issues_hwm),
           issue_comments_hwm = COALESCE(github_cursors.issue_comments_hwm, excluded.issue_comments_hwm),
           pr_review_comments_hwm = COALESCE(github_cursors.pr_review_comments_hwm, excluded.pr_review_comments_hwm),
           updated_at = excluded.updated_at`,
    ).run(tenantId, repo, since, since, since, new Date().toISOString());
  });
}
