// Every statement the Slack connector runs on hippo.db: backfill cursors, the event log, the dead-letter queue and workspace routing.
// `xAt(db, ...)` runs on the caller's handle; the same name without `At` opens hippo.db for that one call.

import type { DatabaseSyncLike } from '../../db.js';
import { onHandle } from '../open.js';

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
       ON CONFLICT(tenant_id, channel_id) DO UPDATE SET latest_ts = excluded.latest_ts, updated_at = excluded.updated_at`,
  ).run(tenantId, channelId, latestTs, new Date().toISOString());
}

export function slackCursor(hippoRoot: string, tenantId: string, channelId: string): string | null {
  return onHandle(hippoRoot, (db) => slackCursorAt(db, tenantId, channelId));
}

export function saveSlackCursor(hippoRoot: string, tenantId: string, channelId: string, latestTs: string): void {
  onHandle(hippoRoot, (db) => saveSlackCursorAt(db, tenantId, channelId, latestTs));
}

// Event log

export function slackEventSeenAt(db: DatabaseSyncLike, eventId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM slack_event_log WHERE event_id = ?`).get(eventId);
  return !!row;
}

/** Records the event unless a row already holds its id; false means another writer got there first. */
export function markSlackEventSeenAt(db: DatabaseSyncLike, eventId: string, memoryId: string | null): boolean {
  const inserted = db
    .prepare(`INSERT OR IGNORE INTO slack_event_log (event_id, ingested_at, memory_id) VALUES (?, ?, ?)`)
    .run(eventId, new Date().toISOString(), memoryId);
  return Number(inserted.changes ?? 0) !== 0;
}

export function slackEventMemoryAt(db: DatabaseSyncLike, eventId: string): string | null {
  // SAFETY: the SELECT names only `memory_id`, a nullable column; .get() returns undefined when no row matches.
  const row = db.prepare(`SELECT memory_id FROM slack_event_log WHERE event_id = ?`).get(eventId) as
    | { memory_id: string | null }
    | undefined;
  return row?.memory_id ?? null;
}

/** What the event log holds for one event id; `memoryId` is null for an event seen without a memory. */
export type SlackEventRecord = { seen: false } | { seen: true; memoryId: string | null };

export function slackEventRecord(hippoRoot: string, eventId: string): SlackEventRecord {
  return onHandle(hippoRoot, (db): SlackEventRecord =>
    slackEventSeenAt(db, eventId) ? { seen: true, memoryId: slackEventMemoryAt(db, eventId) } : { seen: false });
}

export function markSlackEventSeen(hippoRoot: string, eventId: string, memoryId: string | null): void {
  onHandle(hippoRoot, (db) => markSlackEventSeenAt(db, eventId, memoryId));
}

// Deletion lookup

/** The raw memory a Slack message became. The tenant filter keeps one tenant's deletion from reaching another's row with the same ref. */
export function rawMemoryIdForArtifactAt(db: DatabaseSyncLike, artifactRef: string, tenantId: string): string | null {
  // SAFETY: the SELECT projects only `id`; .get() returns undefined when no row matches.
  const row = db
    .prepare(`SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`)
    .get(artifactRef, tenantId) as { id?: string } | undefined;
  return row?.id ?? null;
}

/** A deletion event's standing on one handle: already seen, or the raw memory it targets (null when none). */
export type SlackDeletionTarget = { seen: true } | { seen: false; memoryId: string | null };

export function slackDeletionTarget(
  hippoRoot: string,
  target: { eventId: string; artifactRef: string; tenantId: string },
): SlackDeletionTarget {
  return onHandle(hippoRoot, (db): SlackDeletionTarget =>
    slackEventSeenAt(db, target.eventId)
      ? { seen: true }
      : { seen: false, memoryId: rawMemoryIdForArtifactAt(db, target.artifactRef, target.tenantId) });
}

// Dead-letter queue

export type DlqBucket = 'parse_error' | 'unroutable' | 'signature_fail';

export interface DlqItem {
  id: number;
  tenantId: string;
  teamId: string | null;
  rawPayload: string;
  error: string;
  receivedAt: string;
  retriedAt: string | null;
  bucket: DlqBucket | string;
  retryCount: number;
  signature: string | null;
  slackTimestamp: string | null;
}

/** One row to park; the two Slack-only columns are stored NULL when left out. */
export interface SlackDlqInsert {
  tenantId: string;
  teamId?: string | null;
  rawPayload: string;
  error: string;
  bucket: DlqBucket;
  signature: string | null;
  slackTimestamp?: string | null;
}

/** Raw `slack_dlq` row shape, matching the columns named in the SELECTs below. */
interface DlqRow {
  id?: unknown;
  tenant_id?: unknown;
  team_id?: unknown;
  raw_payload?: unknown;
  error?: unknown;
  received_at?: unknown;
  retried_at?: unknown;
  bucket?: unknown;
  retry_count?: unknown;
  signature?: unknown;
  slack_timestamp?: unknown;
}

function rowToItem(r: DlqRow): DlqItem {
  return {
    id: Number(r.id),
    tenantId: String(r.tenant_id),
    teamId: r.team_id == null ? null : String(r.team_id),
    rawPayload: String(r.raw_payload),
    error: String(r.error),
    receivedAt: String(r.received_at),
    retriedAt: r.retried_at == null ? null : String(r.retried_at),
    bucket: r.bucket == null ? 'parse_error' : String(r.bucket),
    retryCount: Number(r.retry_count ?? 0),
    signature: r.signature == null ? null : String(r.signature),
    slackTimestamp: r.slack_timestamp == null ? null : String(r.slack_timestamp),
  };
}

function insertSlackDlqAt(db: DatabaseSyncLike, row: SlackDlqInsert): number {
  const result = db
    .prepare(
      `INSERT INTO slack_dlq
        (tenant_id, team_id, raw_payload, error, received_at, bucket, signature, slack_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.tenantId,
      row.teamId ?? null,
      row.rawPayload,
      row.error,
      new Date().toISOString(),
      row.bucket,
      row.signature,
      row.slackTimestamp ?? null,
    );
  return Number(result.lastInsertRowid);
}

function listSlackDlqAt(db: DatabaseSyncLike, tenantId: string, limit: number): DlqItem[] {
  // SAFETY: row shape matches the columns named in the SELECT below.
  const rows = db
    .prepare(
      `SELECT id, tenant_id, team_id, raw_payload, error, received_at, retried_at,
              bucket, retry_count, signature, slack_timestamp
         FROM slack_dlq
        WHERE tenant_id = ?
        ORDER BY received_at ASC
        LIMIT ?`,
    )
    .all(tenantId, limit) as DlqRow[];
  return rows.map(rowToItem);
}

function slackDlqEntryAt(db: DatabaseSyncLike, id: number): DlqItem | null {
  // SAFETY: row shape matches the columns named in the SELECT below.
  const row = db
    .prepare(
      `SELECT id, tenant_id, team_id, raw_payload, error, received_at, retried_at,
              bucket, retry_count, signature, slack_timestamp
         FROM slack_dlq
        WHERE id = ?`,
    )
    .get(id) as DlqRow | undefined;
  if (!row) return null;
  return rowToItem(row);
}

function markSlackDlqRetriedAt(db: DatabaseSyncLike, id: number): void {
  db.prepare(`UPDATE slack_dlq SET retried_at = ?, retry_count = retry_count + 1 WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

/** Counts a failed replay and leaves `retried_at` alone, so the row still reads as never drained. */
export function bumpSlackDlqRetryCountAt(db: DatabaseSyncLike, id: number): void {
  db.prepare(`UPDATE slack_dlq SET retry_count = retry_count + 1 WHERE id = ?`).run(id);
}

export function insertSlackDlq(hippoRoot: string, row: SlackDlqInsert): number {
  return onHandle(hippoRoot, (db) => insertSlackDlqAt(db, row));
}

export function listSlackDlq(hippoRoot: string, tenantId: string, limit: number): DlqItem[] {
  return onHandle(hippoRoot, (db) => listSlackDlqAt(db, tenantId, limit));
}

export function slackDlqEntry(hippoRoot: string, id: number): DlqItem | null {
  return onHandle(hippoRoot, (db) => slackDlqEntryAt(db, id));
}

export function markSlackDlqRetried(hippoRoot: string, id: number): void {
  onHandle(hippoRoot, (db) => markSlackDlqRetriedAt(db, id));
}

export function bumpSlackDlqRetryCount(hippoRoot: string, id: number): void {
  onHandle(hippoRoot, (db) => bumpSlackDlqRetryCountAt(db, id));
}

// Workspace routing

/** The tenant a team maps to, or how many workspaces are registered when it maps to none. */
export type SlackTeamRoute = { tenantId: string } | { tenantId: null; workspaceCount: number };

export function slackTeamRouteAt(db: DatabaseSyncLike, teamId: string): SlackTeamRoute {
  // SAFETY: the SELECT names only `tenant_id`; .get() returns undefined when no row matches.
  const row = db
    .prepare(`SELECT tenant_id FROM slack_workspaces WHERE team_id = ?`)
    .get(teamId) as { tenant_id?: string } | undefined;
  if (row?.tenant_id) return { tenantId: row.tenant_id };

  // SAFETY: `COUNT(*) AS c` always returns one row shaped { c }, as a number or a bigint.
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM slack_workspaces`)
    .get() as { c: number | bigint }).c;
  return { tenantId: null, workspaceCount: Number(total) };
}

export function slackTeamRoute(hippoRoot: string, teamId: string): SlackTeamRoute {
  return onHandle(hippoRoot, (db) => slackTeamRouteAt(db, teamId));
}

export interface SlackWorkspace {
  teamId: string;
  tenantId: string;
  addedAt: string; // ISO timestamp
}

/** Upserts on team_id: operators move a workspace between tenants without a delete first. */
function upsertSlackWorkspaceAt(db: DatabaseSyncLike, teamId: string, tenantId: string): SlackWorkspace {
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

function listSlackWorkspacesAt(db: DatabaseSyncLike): SlackWorkspace[] {
  // SAFETY: the SELECT names team_id, tenant_id and added_at, all NOT NULL text columns of slack_workspaces.
  const rows = db
    .prepare(
      `SELECT team_id, tenant_id, added_at FROM slack_workspaces ORDER BY team_id`,
    )
    .all() as Array<{ team_id: string; tenant_id: string; added_at: string }>;
  return rows.map((r) => ({
    teamId: r.team_id,
    tenantId: r.tenant_id,
    addedAt: r.added_at,
  }));
}

/** True when a row was deleted, so the caller can report not-found without a second lookup. */
function removeSlackWorkspaceAt(db: DatabaseSyncLike, teamId: string): boolean {
  const result = db
    .prepare(`DELETE FROM slack_workspaces WHERE team_id = ?`)
    .run(teamId);
  return Number(result.changes) > 0;
}

export function upsertSlackWorkspace(hippoRoot: string, teamId: string, tenantId: string): SlackWorkspace {
  return onHandle(hippoRoot, (db) => upsertSlackWorkspaceAt(db, teamId, tenantId));
}

export function listSlackWorkspaces(hippoRoot: string): SlackWorkspace[] {
  return onHandle(hippoRoot, listSlackWorkspacesAt);
}

export function removeSlackWorkspace(hippoRoot: string, teamId: string): boolean {
  return onHandle(hippoRoot, (db) => removeSlackWorkspaceAt(db, teamId));
}
