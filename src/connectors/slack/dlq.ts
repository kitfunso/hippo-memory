import { type Context, adminActor } from '../../api/index.js';
import {
  bumpSlackDlqRetryCount,
  listSlackDlq,
  markSlackDlqRetried,
  slackDlqEntry,
  type DlqBucket,
  type DlqItem,
  type SlackDlqInsert,
} from '../../store/connectors/slack.js';
import { replayFailed, type ConnectorDlq, type ReplayResult, type ReplayStatus } from '../dlq.js';
import { ingestMessage } from './ingest.js';
import { resolveTenantForSlackTeam } from './tenant-routing.js';
import { verifySlackSignature } from './signature.js';
import { isSlackEventEnvelope, isSlackMessageEvent, type SlackEventEnvelope } from './types.js';
import { handleMessageDeleted } from './deletion.js';
import type { JsonValue } from '../../util/json.js';
import { errorMessage } from '../../util/log.js';

export type { DlqBucket, DlqItem };

/** Slack's dead-letter table; `teamId` and `slackTimestamp` are the columns only it has. */
export const slackDlq: ConnectorDlq<Pick<SlackDlqInsert, 'teamId' | 'slackTimestamp'>, DlqBucket, DlqItem> = {
  letter: (row) => ({ connector: 'slack', ...row }),
  list: listSlackDlq,
};

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

/** Replay a DLQ row via the normal ingest path (`hippo slack dlq replay <id> [--force]`), re-verifying the signature with the CURRENT secret unless forced.
 *  Rows with a NULL signature need --force; replays use today's routing, because the DLQ exists to be drained after the operator fixed routing. */
export async function replayDlqEntry(
  ctx: Pick<Context, 'hippoRoot'>,
  id: number,
  opts: ReplayDlqOpts = {},
): Promise<ReplayResult> {
  const row = slackDlqEntry(ctx.hippoRoot, id);
  if (!row) return replayFailed('not_found', 0, `dlq id ${id} not found`);

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
    return failAndBump(ctx.hippoRoot, row, 'parse_error', `still unparseable: ${errorMessage(e)}`);
  }
  if (!isSlackEventEnvelope(parsed)) {
    return failAndBump(ctx.hippoRoot, row, 'unhandled', 'not an event_callback envelope');
  }

  // Resolve tenant against current state. If still unroutable, bail.
  const tenant = await resolveTenantForSlackTeam(ctx.hippoRoot, parsed.team_id);
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
function checkReplaySignature(row: DlqItem, opts: ReplayDlqOpts): ReplayResult | null {
  if (!row.signature || !row.slackTimestamp) {
    return replayFailed(
      'sig_missing',
      row.retryCount,
      'row has no signature/timestamp (legacy, or redacted before storing); pass --force to replay',
    );
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
      return replayFailed(
        'sig_fail',
        row.retryCount,
        'signature did not verify against current SLACK_SIGNING_SECRET; pass --force to replay anyway',
      );
    }
  }
  return null;
}

function failAndBump(hippoRoot: string, row: DlqItem, status: ReplayStatus, reason: string): ReplayResult {
  bumpSlackDlqRetryCount(hippoRoot, row.id);
  return replayFailed(status, row.retryCount + 1, reason);
}

async function dispatchReplay(
  replayCtx: Context,
  row: DlqItem,
  parsed: JsonValue & SlackEventEnvelope,
): Promise<ReplayResult> {
  const { hippoRoot } = replayCtx;
  const id = row.id;
  const inner = parsed.event;
  if (!isSlackMessageEvent(inner)) {
    return failAndBump(hippoRoot, row, 'unhandled', `unhandled inner event type`);
  }

  if (inner.subtype === 'message_deleted' && inner.deleted_ts) {
    const r = await handleMessageDeleted(replayCtx, {
      teamId: parsed.team_id,
      channelId: inner.channel,
      deletedTs: inner.deleted_ts,
      eventId: parsed.event_id,
    });
    markSlackDlqRetried(hippoRoot, id);
    return { ok: true, status: r.status, memoryId: r.memoryId, retryCount: row.retryCount + 1 };
  }

  const result = await ingestMessage(replayCtx, {
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
