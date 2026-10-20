import { adminActor, type Context } from '../../../api/index.js';
import { replayParked, type ConnectorDlq, type Reingest, type ReplayResult, type SignatureRefusal } from '../dlq.js';
import { ingestMessage } from './ingest.js';
import { resolveTenantForSlackTeam, type SlackFallback } from './tenant-routing.js';
import { verifySlackSignature } from './signature.js';
import { isSlackEventEnvelope, isSlackMessageEvent, type SlackEventEnvelope } from './types.js';
import { handleMessageDeleted } from './deletion.js';
import type { JsonValue } from '../../../base/util/json.js';
import { YEAR_S } from '../../../base/util/time.js';
import type {
  SlackDlqBucket as DlqBucket,
  SlackDlqItem as DlqItem,
  SlackDlqInsert,
} from '../../../store/port/connectors.js';

export type { DlqBucket, DlqItem };

/** Slack's dead-letter table; `teamId` and `slackTimestamp` are the columns only it has. */
export const slackDlq: ConnectorDlq<'slack', Pick<SlackDlqInsert, 'teamId' | 'slackTimestamp'>, DlqBucket> = {
  connector: 'slack',
  letter: (row) => ({ connector: 'slack', ...row }),
};

export interface ReplayDlqOptions {
  /** Skip signature verification when the row's signature/timestamp are missing or stale. */
  force?: boolean;
  /** Current signing secret. If omitted, signature check is skipped (force-only path). */
  signingSecret?: string;
  /** Now (unix seconds) override for tests. */
  now?: number;
  /** Skew window override for tests. */
  skewSeconds?: number;
  /** The SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK escape hatch, as the CLI read it. */
  allowUnknownTeamFallback?: boolean;
}

/** Replay a DLQ row via the normal ingest path (`hippo slack dlq replay <id> [--force]`), re-verifying the signature
 * with the CURRENT secret unless forced. A NULL signature needs --force; replays use today's routing. */
export async function replayDlqEntry(
  ctx: Pick<Context, 'tenantId' | 'store' | 'config'>,
  id: number,
  opts: ReplayDlqOptions = {},
): Promise<ReplayResult> {
  return replayParked<'slack', JsonValue & SlackEventEnvelope>(
    {
      dlq: slackDlq,
      refuseSignature: (row) => refuseSignature(row, opts),
      isEnvelope: isSlackEventEnvelope,
      notEnvelope: 'not an event_callback envelope',
      reingest: (_row, envelope) =>
        reingest(ctx, envelope, { hostTenant: ctx.tenantId, allowUnknown: opts.allowUnknownTeamFallback === true }),
    },
    ctx.store,
    id,
    opts.force === true,
  );
}

/** A missing signature or timestamp refuses even without a secret; a mismatch needs the current secret to show. */
function refuseSignature(row: DlqItem, opts: ReplayDlqOptions): SignatureRefusal | null {
  if (!row.signature || !row.slackTimestamp) {
    return {
      status: 'sig_missing',
      reason: 'row has no signature/timestamp (legacy, or redacted before storing); pass --force to replay',
    };
  }
  if (!opts.signingSecret) return null;
  const ok = verifySlackSignature({
    rawBody: row.rawPayload,
    signature: row.signature,
    timestamp: row.slackTimestamp,
    signingSecret: opts.signingSecret,
    now: opts.now,
    // Replays happen long after the fact, so give them a wider skew unless overridden.
    skewSeconds: opts.skewSeconds ?? YEAR_S,
  });
  if (ok) return null;
  return {
    status: 'sig_fail',
    reason: 'signature did not verify against current SLACK_SIGNING_SECRET; pass --force to replay anyway',
  };
}

async function reingest(
  { store, config }: Pick<Context, 'store' | 'config'>,
  envelope: JsonValue & SlackEventEnvelope,
  fallback: SlackFallback,
): Promise<Reingest> {
  const tenantId = await resolveTenantForSlackTeam(store, envelope.team_id, fallback);
  if (!tenantId) return { ok: false, status: 'unroutable', reason: `team_id ${envelope.team_id} still unroutable` };
  const inner = envelope.event;
  if (!isSlackMessageEvent(inner)) return { ok: false, status: 'unhandled', reason: 'unhandled inner event type' };

  const replayCtx: Context = { tenantId, actor: adminActor('connector:slack:replay'), store, config };
  if (inner.subtype === 'message_deleted' && inner.deleted_ts) {
    const r = await handleMessageDeleted(replayCtx, {
      teamId: envelope.team_id,
      channelId: inner.channel,
      deletedTs: inner.deleted_ts,
      eventId: envelope.event_id,
    });
    return { ok: true, status: r.status, memoryId: r.memoryId };
  }
  const result = await ingestMessage(replayCtx, {
    teamId: envelope.team_id,
    channel: {
      id: inner.channel,
      is_private: inner.channel_type !== 'channel',
      is_im: inner.channel_type === 'im',
      is_mpim: inner.channel_type === 'mpim',
    },
    message: inner,
    eventId: envelope.event_id,
  });
  return { ok: true, status: result.status, memoryId: result.memoryId };
}
