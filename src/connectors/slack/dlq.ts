import type { DatabaseSyncLike } from '../../db.js';
import { type Context, adminActor } from '../../api.js';
import {
  bumpSlackDlqRetryCount,
  insertSlackDlq,
  insertSlackDlqAt,
  listSlackDlqAt,
  markSlackDlqRetried,
  slackDlqEntry,
  type DlqBucket,
  type DlqItem,
  type SlackDlqInsert,
} from '../../store/connectors/slack.js';
import { ingestMessage } from './ingest.js';
import { resolveTenantForTeamOnRoot } from './tenant-routing.js';
import { verifySlackSignature } from './signature.js';
import { isSlackEventEnvelope, isSlackMessageEvent, type SlackEventEnvelope } from './types.js';
import { handleMessageDeleted } from './deletion.js';
import { redactPayload, DLQ_REDACTED_NOTE } from '../../secret-detect.js';
import type { JsonValue } from '../../json.js';

export type { DlqBucket, DlqItem };
export { slackDlqEntryAt as getDlqEntry, markSlackDlqRetriedAt as markDlqRetried } from '../../store/connectors/slack.js';

/**
 * writeToDlq is bucket-aware. `bucket` defaults to
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

/** The row to park: secrets redacted, the unroutable sentinel and the default bucket filled in. */
function dlqInsert(opts: WriteDlqOpts): SlackDlqInsert {
  const rawPayload = redactPayload(opts.rawPayload);
  // A redacted body can never match its signature, so the row keeps none and replay needs --force.
  const redacted = rawPayload !== opts.rawPayload;
  return {
    tenantId: opts.tenantId ?? '__unroutable__',
    teamId: opts.teamId ?? null,
    rawPayload,
    error: redacted ? `${opts.error}; ${DLQ_REDACTED_NOTE}` : opts.error,
    bucket: opts.bucket ?? 'parse_error',
    signature: redacted ? null : opts.signature ?? null,
    slackTimestamp: opts.slackTimestamp ?? null,
  };
}

export function writeToDlq(db: DatabaseSyncLike, opts: WriteDlqOpts): number {
  return insertSlackDlqAt(db, dlqInsert(opts));
}

/** writeToDlq on a handle opened for the one insert. */
export function writeToDlqOnRoot(hippoRoot: string, opts: WriteDlqOpts): number {
  return insertSlackDlq(hippoRoot, dlqInsert(opts));
}

export function listDlq(db: DatabaseSyncLike, opts: { tenantId: string; limit?: number }): DlqItem[] {
  return listSlackDlqAt(db, opts.tenantId, opts.limit ?? 100);
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
  const row = slackDlqEntry(ctx.hippoRoot, id);
  if (!row) {
    return { ok: false, status: 'not_found', memoryId: null, retryCount: 0, reason: `dlq id ${id} not found` };
  }

  // Signature verification (current secret, not previous).
  if (!opts.force) {
    const sigFailure = checkReplaySignature(row, opts);
    if (sigFailure) return sigFailure;
  }

  // Parse + dispatch.
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(row.rawPayload);
  } catch (e) {
    return failAndBump(ctx.hippoRoot, row, 'parse_error', `still unparseable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isSlackEventEnvelope(parsed)) {
    return failAndBump(ctx.hippoRoot, row, 'unhandled', 'not an event_callback envelope');
  }

  // Resolve tenant against current state. If still unroutable, bail.
  const tenant = resolveTenantForTeamOnRoot(ctx.hippoRoot, parsed.team_id);
  if (!tenant) {
    return failAndBump(ctx.hippoRoot, row, 'unroutable', `team_id ${parsed.team_id} still unroutable`);
  }

  const replayCtx: Context = {
    hippoRoot: ctx.hippoRoot,
    tenantId: tenant,
    actor: adminActor('connector:slack:replay'),
  };
  return dispatchReplay(replayCtx, row, parsed);
}

/** The failure result when the row cannot pass the signature gate, else null; never bumps the count. */
function checkReplaySignature(row: DlqItem, opts: ReplayDlqOpts): ReplayDlqResult | null {
  if (!row.signature || !row.slackTimestamp) {
    return {
      ok: false,
      status: 'sig_missing',
      memoryId: null,
      retryCount: row.retryCount,
      reason: 'row has no signature/timestamp (legacy, or redacted before storing); pass --force to replay',
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
  return null;
}

function failAndBump(hippoRoot: string, row: DlqItem, status: string, reason: string): ReplayDlqResult {
  bumpSlackDlqRetryCount(hippoRoot, row.id);
  return { ok: false, status, memoryId: null, retryCount: row.retryCount + 1, reason };
}

function dispatchReplay(
  replayCtx: Context,
  row: DlqItem,
  parsed: JsonValue & SlackEventEnvelope,
): ReplayDlqResult {
  const { hippoRoot } = replayCtx;
  const id = row.id;
  const inner = parsed.event;
  if (!isSlackMessageEvent(inner)) {
    return failAndBump(hippoRoot, row, 'unhandled', `unhandled inner event type`);
  }

  if (inner.subtype === 'message_deleted' && inner.deleted_ts) {
    const r = handleMessageDeleted(replayCtx, {
      teamId: parsed.team_id,
      channelId: inner.channel,
      deletedTs: inner.deleted_ts,
      eventId: parsed.event_id,
    });
    markSlackDlqRetried(hippoRoot, id);
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
  markSlackDlqRetried(hippoRoot, id);
  return { ok: true, status: result.status, memoryId: result.memoryId, retryCount: row.retryCount + 1 };
}
