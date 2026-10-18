// Every statement the Slack connector runs on hippo.db: backfill cursors, the event log, the dead-letter queue and
// workspace routing. Each `xAt(db, ...)` runs on the caller's handle.

import type { DatabaseSyncLike } from '../../../db/index.js';
import type { ConnectorEventRecord } from '../../port.js';
import { eventMemoryAt, eventRecordAt, eventSeenAt, markEventSeenAt, type EventLogSpec } from './event-log.js';
import { dlqAccess } from './dlq.js';
import type { SlackTeamRoute, SlackDlqInsert, SlackDlqItem as DlqItem, SlackWorkspace } from '../../port/connectors.js';

// Backfill cursors

export function slackCursorAt(db: DatabaseSyncLike, tenantId: string, channelId: string): string | null {
  // SAFETY: the SELECT names the single `latest_ts` column; sqlite returns undefined when no row matches.
  const row = db
    .prepare(`SELECT latest_ts FROM slack_cursors WHERE tenant_id=? AND channel_id=?`)
    .get(tenantId, channelId) as { latest_ts?: string } | undefined;
  return row?.latest_ts ?? null;
}

export function saveSlackCursorAt(db: DatabaseSyncLike, tenantId: string, channelId: string, latestTs: string): void {
  db.prepare(
    `INSERT INTO slack_cursors (tenant_id, channel_id, latest_ts, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(tenant_id, channel_id) DO UPDATE SET latest_ts = excluded.latest_ts, updated_at =
       excluded.updated_at`,
  ).run(tenantId, channelId, latestTs, new Date().toISOString());
}

// Event log

const SLACK_LOG: EventLogSpec = { table: 'slack_event_log', keyColumn: 'event_id' };

export function slackEventSeenAt(db: DatabaseSyncLike, eventId: string): boolean {
  return eventSeenAt(db, SLACK_LOG, eventId);
}

/** Records the event unless a row already holds its id; false means another writer got there first. */
export function markSlackEventSeenAt(db: DatabaseSyncLike, eventId: string, memoryId: string | null): boolean {
  return markEventSeenAt(db, SLACK_LOG, eventId, [], memoryId);
}

export function slackEventMemoryAt(db: DatabaseSyncLike, eventId: string): string | null {
  return eventMemoryAt(db, SLACK_LOG, eventId);
}

export function slackEventRecordAt(db: DatabaseSyncLike, eventId: string): ConnectorEventRecord {
  return eventRecordAt(db, SLACK_LOG, eventId);
}

// Deletion lookup

/** The raw memory a Slack message became. The tenant filter keeps one tenant's deletion from reaching another's row
 * with the same ref. */
export function rawMemoryIdForArtifactAt(db: DatabaseSyncLike, artifactRef: string, tenantId: string): string | null {
  // SAFETY: the SELECT projects only `id`; .get() returns undefined when no row matches.
  const row = db
    .prepare(`SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`)
    .get(artifactRef, tenantId) as { id?: string } | undefined;
  return row?.id ?? null;
}

export const SLACK_DLQ = dlqAccess<DlqItem, SlackDlqInsert>('slack_dlq', [
  { field: 'id', column: 'id', kind: 'int' },
  { field: 'tenantId', column: 'tenant_id', kind: 'text', insert: true },
  { field: 'teamId', column: 'team_id', kind: 'nullableText', insert: true },
  { field: 'rawPayload', column: 'raw_payload', kind: 'text', insert: true },
  { field: 'error', column: 'error', kind: 'text', insert: true },
  { field: 'receivedAt', column: 'received_at', kind: 'text' },
  { field: 'retriedAt', column: 'retried_at', kind: 'nullableText' },
  { field: 'bucket', column: 'bucket', kind: 'bucket', insert: true },
  { field: 'retryCount', column: 'retry_count', kind: 'count' },
  { field: 'signature', column: 'signature', kind: 'nullableText', insert: true },
  { field: 'slackTimestamp', column: 'slack_timestamp', kind: 'nullableText', insert: true },
]);

export function slackTeamRouteAt(db: DatabaseSyncLike, teamId: string): SlackTeamRoute {
  // SAFETY: the SELECT names only `tenant_id`; .get() returns undefined when no row matches.
  const row = db.prepare(`SELECT tenant_id FROM slack_workspaces WHERE team_id = ?`).get(teamId) as
    | { tenant_id?: string }
    | undefined;
  if (row?.tenant_id) return { tenantId: row.tenant_id };

  // SAFETY: `COUNT(*) AS c` always returns one row shaped { c }, as a number or a bigint.
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM slack_workspaces`).get() as { c: number | bigint }).c;
  return { tenantId: null, workspaceCount: Number(total) };
}

/** Upserts on team_id: operators move a workspace between tenants without a delete first. */
export function upsertSlackWorkspaceAt(db: DatabaseSyncLike, teamId: string, tenantId: string): SlackWorkspace {
  const addedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO slack_workspaces (team_id, tenant_id, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       added_at = excluded.added_at`,
  ).run(teamId, tenantId, addedAt);
  return { teamId, tenantId, addedAt };
}

export function listSlackWorkspacesAt(db: DatabaseSyncLike): SlackWorkspace[] {
  // SAFETY: the SELECT names team_id, tenant_id and added_at, all NOT NULL text columns of slack_workspaces.
  const rows = db.prepare(`SELECT team_id, tenant_id, added_at FROM slack_workspaces ORDER BY team_id`).all() as Array<{
    team_id: string;
    tenant_id: string;
    added_at: string;
  }>;
  return rows.map((r) => ({
    teamId: r.team_id,
    tenantId: r.tenant_id,
    addedAt: r.added_at,
  }));
}

/** True when a row was deleted, so the caller can report not-found without a second lookup. */
export function removeSlackWorkspaceAt(db: DatabaseSyncLike, teamId: string): boolean {
  const result = db.prepare(`DELETE FROM slack_workspaces WHERE team_id = ?`).run(teamId);
  return Number(result.changes) > 0;
}
