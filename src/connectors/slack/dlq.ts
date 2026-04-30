import type { DatabaseSyncLike } from '../../db.js';
import type { Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { ingestMessage } from './ingest.js';
import { resolveTenantForTeam } from './tenant-routing.js';
import { verifySlackSignature } from './signature.js';
import { isSlackEventEnvelope, isSlackMessageEvent } from './types.js';
import { handleMessageDeleted } from './deletion.js';

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

/**
 * v0.39 commit 3: writeToDlq is now bucket-aware. `bucket` defaults to
 * 'parse_error' to preserve the legacy single-arg call sites while letting
 * new callers tag rows for `hippo slack dlq replay` triage.
 *
 * `tenantId: null` means "no tenant resolved" (unroutable team). Stored as
 * the sentinel '__unroutable__' so the column stays NOT NULL — a mismatch
 * the listing CLI surfaces explicitly.
 */
export interface WriteDlqOpts {
  tenantId: string | null;
  rawPayload: string;
  error: string;
  bucket?: DlqBucket;
  teamId?: string | null;
  signature?: string | null;
  slackTimestamp?: string | null;
}

export function writeToDlq(db: DatabaseSyncLike, opts: WriteDlqOpts): number {
  const result = db
    .prepare(
      `INSERT INTO slack_dlq
        (tenant_id, team_id, raw_payload, error, received_at, bucket, signature, slack_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.tenantId ?? '__unroutable__',
      opts.teamId ?? null,
      opts.rawPayload,
      opts.error,
      new Date().toISOString(),
      opts.bucket ?? 'parse_error',
      opts.signature ?? null,
      opts.slackTimestamp ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function listDlq(db: DatabaseSyncLike, opts: { tenantId: string; limit?: number }): DlqItem[] {
  const rows = db
    .prepare(
      `SELECT id, tenant_id, team_id, raw_payload, error, received_at, retried_at,
              bucket, retry_count, signature, slack_timestamp
         FROM slack_dlq
        WHERE tenant_id = ?
        ORDER BY received_at ASC
        LIMIT ?`,
    )
    .all(opts.tenantId, opts.limit ?? 100) as Array<Record<string, unknown>>;
  return rows.map(rowToItem);
}

export function getDlqEntry(db: DatabaseSyncLike, id: number): DlqItem | null {
  const row = db
    .prepare(
      `SELECT id, tenant_id, team_id, raw_payload, error, received_at, retried_at,
              bucket, retry_count, signature, slack_timestamp
         FROM slack_dlq
        WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToItem(row);
}

function rowToItem(r: Record<string, unknown>): DlqItem {
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

export function markDlqRetried(db: DatabaseSyncLike, id: number): void {
  db.prepare(`UPDATE slack_dlq SET retried_at = ?, retry_count = retry_count + 1 WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export interface ReplayDlqOpts {
  /** Skip signature verification when the row's signature/timestamp are missing or stale. */
  force?: boolean;
  /** Current signing secret. If omitted, signature check is skipped (force-only path). */
  signingSecret?: string;
  /** Now (unix seconds) override for tests. */
  now?: number;
  /** Skew window override for tests. */
  skewSeconds?: number;
}

export interface ReplayDlqResult {
  ok: boolean;
  status: string;
  memoryId: string | null;
  retryCount: number;
  reason?: string;
}

/**
 * Replay a DLQ row through the normal ingest path. Used by `hippo slack dlq
 * replay <id> [--force]`.
 *
 * Behavior:
 *   1. SELECT the row.
 *   2. If signature + slack_timestamp are present and `signingSecret` is set,
 *      re-verify with the CURRENT secret (not previous). Failure → bail unless
 *      --force. Legacy rows from before v19 may have NULL signature; those
 *      require --force to replay safely.
 *   3. Re-parse the raw_payload and dispatch to ingestMessage / handleMessageDeleted.
 *   4. On success: mark retried_at, increment retry_count.
 *   5. On failure: increment retry_count only, leave the row.
 *
 * The replay always uses the routing the deployment has NOW (current
 * slack_workspaces table + env), not whatever was in effect when the original
 * envelope was DLQed. That is intentional: the DLQ exists to be drained after
 * the operator fixed the routing.
 */
export function replayDlqEntry(
  ctx: Pick<Context, 'hippoRoot'>,
  id: number,
  opts: ReplayDlqOpts = {},
): ReplayDlqResult {
  const db = openHippoDb(ctx.hippoRoot);
  let row: DlqItem | null;
  try {
    row = getDlqEntry(db, id);
  } finally {
    closeHippoDb(db);
  }
  if (!row) {
    return { ok: false, status: 'not_found', memoryId: null, retryCount: 0, reason: `dlq id ${id} not found` };
  }

  // Signature verification (current secret, not previous).
  if (!opts.force) {
    if (!row.signature || !row.slackTimestamp) {
      return {
        ok: false,
        status: 'sig_missing',
        memoryId: null,
        retryCount: row.retryCount,
        reason: 'legacy row without signature/timestamp; pass --force to replay',
      };
    }
    if (opts.signingSecret) {
      const ok = verifySlackSignature({
        rawBody: row.rawPayload,
        signature: row.signature,
        timestamp: row.slackTimestamp,
        signingSecret: opts.signingSecret,
        now: opts.now,
        // Replays happen long after the fact — give them a wider skew unless overridden.
        skewSeconds: opts.skewSeconds ?? 60 * 60 * 24 * 365,
      });
      if (!ok) {
        return {
          ok: false,
          status: 'sig_fail',
          memoryId: null,
          retryCount: row.retryCount,
          reason: 'signature did not verify against current SLACK_SIGNING_SECRET; pass --force to replay anyway',
        };
      }
    }
  }

  // Parse + dispatch.
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.rawPayload);
  } catch (e) {
    bumpRetryCount(ctx.hippoRoot, id);
    return {
      ok: false,
      status: 'parse_error',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: `still unparseable: ${(e as Error).message}`,
    };
  }
  if (!isSlackEventEnvelope(parsed)) {
    bumpRetryCount(ctx.hippoRoot, id);
    return {
      ok: false,
      status: 'unhandled',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: 'not an event_callback envelope',
    };
  }

  // Resolve tenant against current state. If still unroutable, bail.
  const db2 = openHippoDb(ctx.hippoRoot);
  let tenant: string | null;
  try {
    tenant = resolveTenantForTeam(db2, parsed.team_id);
  } finally {
    closeHippoDb(db2);
  }
  if (!tenant) {
    bumpRetryCount(ctx.hippoRoot, id);
    return {
      ok: false,
      status: 'unroutable',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: `team_id ${parsed.team_id} still unroutable`,
    };
  }

  const replayCtx: Context = {
    hippoRoot: ctx.hippoRoot,
    tenantId: tenant,
    actor: 'connector:slack:replay',
  };

  const inner = parsed.event;
  if (!isSlackMessageEvent(inner)) {
    bumpRetryCount(ctx.hippoRoot, id);
    return {
      ok: false,
      status: 'unhandled',
      memoryId: null,
      retryCount: row.retryCount + 1,
      reason: `unhandled inner event type`,
    };
  }

  if (inner.subtype === 'message_deleted' && inner.deleted_ts) {
    const r = handleMessageDeleted(replayCtx, {
      teamId: parsed.team_id,
      channelId: inner.channel,
      deletedTs: inner.deleted_ts,
      eventId: parsed.event_id,
    });
    markRetried(ctx.hippoRoot, id);
    return { ok: true, status: r.status, memoryId: r.memoryId, retryCount: row.retryCount + 1 };
  }

  const result = ingestMessage(replayCtx, {
    teamId: parsed.team_id,
    channel: {
      id: inner.channel,
      is_private: inner.channel_type !== 'channel',
      is_im: inner.channel_type === 'im',
      is_mpim: inner.channel_type === 'mpim',
    },
    message: inner,
    eventId: parsed.event_id,
  });
  markRetried(ctx.hippoRoot, id);
  return { ok: true, status: result.status, memoryId: result.memoryId, retryCount: row.retryCount + 1 };
}

function markRetried(hippoRoot: string, id: number): void {
  const db = openHippoDb(hippoRoot);
  try { markDlqRetried(db, id); }
  finally { closeHippoDb(db); }
}

function bumpRetryCount(hippoRoot: string, id: number): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`UPDATE slack_dlq SET retry_count = retry_count + 1 WHERE id = ?`).run(id);
  } finally {
    closeHippoDb(db);
  }
}
