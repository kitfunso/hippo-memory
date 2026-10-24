// The GitHub connector's tables: event log, dead-letter queue, tenant routing and backfill cursors.

import type { DatabaseSyncLike } from '../../../db/index.js';
import type { ConnectorEventRecord } from '../../port.js';
import { eventMemory, eventRecord, eventSeen, markEventSeen, type EventLogSpec } from './event-log.js';
import { dlqAccess } from './dlq.js';
import type { TenantRoute, GitHubDlqInsert, GitHubDlqItem as DlqItem, GitHubStream } from '../../port/connectors.js';
import { cachedStatement } from '../../../db/statement-cache.js';

/** One github_event_log row to write; `memoryId` is null for an event that produced no memory. */
export interface GitHubEventLogEntry {
  idempotencyKey: string;
  deliveryId: string;
  eventName: string;
  memoryId: string | null;
}

const GITHUB_LOG: EventLogSpec = { table: 'github_event_log', keyColumn: 'idempotency_key' };

export function githubEventSeen(db: DatabaseSyncLike, idempotencyKey: string): boolean {
  return eventSeen(db, GITHUB_LOG, idempotencyKey);
}

export function githubEventMemory(db: DatabaseSyncLike, idempotencyKey: string): string | null {
  return eventMemory(db, GITHUB_LOG, idempotencyKey);
}

/** False when the key was already logged, so a caller inside a write scope can roll its own row back. */
export function markGitHubEventSeen(db: DatabaseSyncLike, entry: GitHubEventLogEntry): boolean {
  return markEventSeen(
    db,
    GITHUB_LOG,
    entry.idempotencyKey,
    [
      ['delivery_id', entry.deliveryId],
      ['event_name', entry.eventName],
    ],
    entry.memoryId,
  );
}

export function githubEventRecord(db: DatabaseSyncLike, idempotencyKey: string): ConnectorEventRecord {
  return eventRecord(db, GITHUB_LOG, idempotencyKey);
}

export const GITHUB_DLQ = dlqAccess<DlqItem, GitHubDlqInsert>('github_dlq', [
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

/** The installation's tenant when one is named, else the repository's first to register it; with no match, how many
 * rows it could have come from. */
export function githubRoute(
  db: DatabaseSyncLike,
  { installationId, repoFullName }: { installationId?: string | null; repoFullName?: string | null },
): TenantRoute {
  if (installationId) {
    const row = cachedStatement(db, `SELECT tenant_id FROM github_installations WHERE installation_id = ?`).get(
      installationId,
    ) as { tenant_id?: string } | undefined;
    return row?.tenant_id ? { tenantId: row.tenant_id } : { tenantId: null, routes: rowCount(db, 'installations') };
  }
  const row = repoFullName
    ? (cachedStatement(
        db,
        `SELECT tenant_id FROM github_repositories WHERE repo_full_name = ? ORDER BY added_at, tenant_id LIMIT 1`,
      ).get(repoFullName) as { tenant_id?: string } | undefined)
    : undefined;
  if (row?.tenant_id) return { tenantId: row.tenant_id };
  return { tenantId: null, routes: rowCount(db, 'installations') + rowCount(db, 'repositories') };
}

function rowCount(db: DatabaseSyncLike, table: 'installations' | 'repositories'): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(db, `SELECT COUNT(*) AS c FROM github_${table}`).get() as { c: number | bigint };
  return Number(row.c);
}

const HWM_COLUMN = {
  issues: 'issues_hwm',
  issueComments: 'issue_comments_hwm',
  prReviewComments: 'pr_review_comments_hwm',
} as const satisfies Record<GitHubStream, string>;

export function githubCursor(
  db: DatabaseSyncLike,
  tenantId: string,
  repo: string,
  stream: GitHubStream,
): string | null {
  const column = HWM_COLUMN[stream];
  const row = cachedStatement(
    db,
    `SELECT ${column} AS hwm FROM github_cursors WHERE tenant_id = ? AND repo_full_name = ?`,
  ).get(tenantId, repo) as { hwm?: string | null } | undefined;
  return row?.hwm ?? null;
}

/** `keepSaved` leaves a mark already saved as it is, as a first run's `--since` seed needs. */
export function saveGitHubCursor(
  db: DatabaseSyncLike,
  { tenantId, repo, stream }: { tenantId: string; repo: string; stream: GitHubStream },
  value: string,
  keepSaved: boolean,
): void {
  const column = HWM_COLUMN[stream];
  const kept = keepSaved ? `COALESCE(github_cursors.${column}, excluded.${column})` : `excluded.${column}`;
  cachedStatement(
    db,
    `INSERT INTO github_cursors (tenant_id, repo_full_name, ${column}, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, repo_full_name)
     DO UPDATE SET ${column} = ${kept}, updated_at = excluded.updated_at`,
  ).run(tenantId, repo, value, new Date().toISOString());
}
