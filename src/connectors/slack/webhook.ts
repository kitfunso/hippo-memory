import { envSlackSigningSecret, envSlackSigningSecretPrevious } from '../../env.js';
import { verifySlackSignature } from './signature.js';
import { isSlackEventEnvelope, isSlackMessageEvent } from './types.js';
import { ingestMessage } from './ingest.js';
import { handleMessageDeleted } from './deletion.js';
import { writeToDlq } from './dlq.js';
import { resolveTenantForTeam } from './tenant-routing.js';
import { resolveTenantId } from '../../tenant.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import type { Context } from '../../api.js';
import {
  HttpError,
  JSON_HEADERS,
  isHeaderString,
  isJsonObjectRecord,
  readBody,
  sendJson,
  type JsonValue,
  type WebhookRequest,
} from '../../http-util.js';

/**
 * Slack Events API webhook. Auth is signature-based (HMAC over the raw
 * body with SLACK_SIGNING_SECRET); Bearer is NOT required, which is why
 * this route is in PUBLIC_ROUTES. The route is responsible for:
 *   1. Echoing the one-time url_verification challenge.
 *   2. Verifying the HMAC on every other inbound payload.
 *   3. Resolving body.team_id → tenantId via slack_workspaces, falling
 *      back to HIPPO_TENANT then 'default'.
 *   4. Dispatching event_callback envelopes to ingestMessage /
 *      handleMessageDeleted.
 *   5. Parking malformed or unhandled payloads in slack_dlq and STILL
 *      ACKing 200 - Slack retries forever otherwise.
 *
 * When SLACK_SIGNING_SECRET is unset we return 404, not
 * 503, so an external probe cannot distinguish "route gated off by config"
 * from "route does not exist on this build".
 *
 * Bearer auth is skipped on purpose: server.ts checks isPublicRoute before calling this.
 */
export async function handleSlackEventsWebhook({ req, res, opts }: WebhookRequest): Promise<void> {
  const rawBody = await readBody(req);
  const secret = envSlackSigningSecret();
  if (!secret) {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const previousSecret = envSlackSigningSecretPrevious();
  const sig = req.headers['x-slack-signature'];
  const tsHdr = req.headers['x-slack-request-timestamp'];
  const sigStr = isHeaderString(sig) ? sig : null;
  const tsStr = isHeaderString(tsHdr) ? tsHdr : null;
  if (
    sigStr === null ||
    tsStr === null ||
    !verifySlackSignature({
      rawBody,
      timestamp: tsStr,
      signature: sigStr,
      signingSecret: secret,
      previousSecret,
    })
  ) {
    throw new HttpError(401, 'invalid Slack signature');
  }
  // Cheap regex extracts team_id from a (possibly malformed) raw body so the
  // DLQ row carries it for triage even when JSON.parse fails.
  const teamIdFromRaw = (() => {
    const m = rawBody.match(/"team_id"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  })();
  let body: JsonValue | undefined;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Attribute the parse failure to the originating workspace via the regex-extracted
    // team_id; a null or unknown team writes tenantId=null, which lands as '__unroutable__'.
    const db = openHippoDb(opts.hippoRoot);
    try {
      const parseFailTenant =
        teamIdFromRaw !== null ? resolveTenantForTeam(db, teamIdFromRaw) : null;
      writeToDlq(db, {
        tenantId: parseFailTenant, // null → '__unroutable__' sentinel
        teamId: teamIdFromRaw,
        rawPayload: rawBody,
        error: 'invalid JSON',
        bucket: 'parse_error',
        signature: sigStr,
        slackTimestamp: tsStr,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }
  if (isJsonObjectRecord(body)) {
    const bodyRecord = body;
    if (bodyRecord.type === 'url_verification') {
      sendJson(res, 200, {
        challenge: String(bodyRecord.challenge ?? ''),
      });
      return;
    }
  }
  // Resolve tenant, failing closed: when slack_workspaces is non-empty
  // and the team_id is unknown, resolveTenantForTeam returns null and we
  // park the envelope in slack_dlq with bucket='unroutable'. Mandatory ACK
  // 200 so Slack stops retrying; do NOT call ingest.
  let resolvedTenant: string | null = null;
  if (body !== undefined && isSlackEventEnvelope(body)) {
    const db = openHippoDb(opts.hippoRoot);
    try {
      resolvedTenant = resolveTenantForTeam(db, body.team_id);
    } finally {
      closeHippoDb(db);
    }
    if (resolvedTenant === null) {
      const db2 = openHippoDb(opts.hippoRoot);
      try {
        writeToDlq(db2, {
          tenantId: null, // unroutable - stored as '__unroutable__'
          teamId: body.team_id,
          rawPayload: rawBody,
          error: `unroutable team_id: ${body.team_id}`,
          bucket: 'unroutable',
          signature: sigStr,
          slackTimestamp: tsStr,
        });
      } finally {
        closeHippoDb(db2);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }
  } else {
    // Non-envelope payload: use env tenant for the DLQ row's bookkeeping.
    resolvedTenant = resolveTenantId({});
  }
  const ctx: Context = {
    hippoRoot: opts.hippoRoot,
    tenantId: resolvedTenant,
    actor: { subject: 'connector:slack', role: 'admin' },
  };
  if (body === undefined || !isSlackEventEnvelope(body)) {
    const db = openHippoDb(ctx.hippoRoot);
    try {
      writeToDlq(db, {
        tenantId: ctx.tenantId,
        teamId: teamIdFromRaw,
        rawPayload: rawBody,
        error: 'not an event_callback envelope',
        bucket: 'parse_error',
        signature: sigStr,
        slackTimestamp: tsStr,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }
  const inner = body.event;
  if (isSlackMessageEvent(inner)) {
    if (inner.subtype === 'message_deleted' && inner.deleted_ts) {
      const r = handleMessageDeleted(ctx, {
        teamId: body.team_id,
        channelId: inner.channel,
        deletedTs: inner.deleted_ts,
        eventId: body.event_id,
      });
      sendJson(res, 200, { ok: true, status: r.status });
      return;
    }
    const r = ingestMessage(ctx, {
      teamId: body.team_id,
      // channel privacy isn't on the inner event; use channel_type as a
      // proxy. 'group'|'im'|'mpim' → private. 'channel' → public. Unknown
      // → private (fail closed).
      channel: {
        id: inner.channel,
        is_private: inner.channel_type !== 'channel',
        is_im: inner.channel_type === 'im',
        is_mpim: inner.channel_type === 'mpim',
      },
      message: inner,
      eventId: body.event_id,
    });
    sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
    return;
  }
  const db = openHippoDb(ctx.hippoRoot);
  try {
    writeToDlq(db, {
      tenantId: ctx.tenantId,
      teamId: body.team_id,
      rawPayload: rawBody,
      error: `unhandled event type: ${inner.type ?? 'unknown'}`,
      bucket: 'parse_error',
      signature: sigStr,
      slackTimestamp: tsStr,
    });
  } finally {
    closeHippoDb(db);
  }
  sendJson(res, 200, { ok: true, status: 'dlq' });
  return;
}
