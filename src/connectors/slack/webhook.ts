import { envSlackSigningSecret, envSlackSigningSecretPrevious } from '../../util/env.js';
import type { ServerResponse } from 'node:http';
import { verifySlackSignature } from './signature.js';
import { isSlackEventEnvelope, isSlackMessageEvent, type SlackEventEnvelope } from './types.js';
import { ingestMessage } from './ingest.js';
import { handleMessageDeleted } from './deletion.js';
import { parkInDlq } from '../dlq.js';
import { slackDlq, type DlqBucket } from './dlq.js';
import { resolveTenantForSlackTeam } from './tenant-routing.js';
import { resolveTenantId } from '../../store/tenant.js';
import type { Context } from '../../api/index.js';
import type { HippoStore } from '../../store/index.js';
import { HttpError, JSON_HEADERS, isHeaderString, closeIfBodyUnread, readWebhookBody, sendJson, type WebhookRequest } from '../../util/http-util.js';
import { type JsonValue, isJsonObject } from '../../util/json.js';

/** Slack Events API webhook: HMAC over the raw body with SLACK_SIGNING_SECRET, no Bearer (hence PUBLIC_ROUTES); malformed payloads go to slack_dlq, ACK 200.
 *  404 (not 503) when the secret is unset, so a probe cannot tell a gated-off route from a missing one. */
export async function handleSlackEventsWebhook(request: WebhookRequest, store?: HippoStore): Promise<void> {
  const { req, res, opts } = request;
  // Secret and headers before the body, so a caller with neither cannot make the server buffer one.
  const secret = envSlackSigningSecret();
  if (!secret) {
    closeIfBodyUnread(request);
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const previousSecret = envSlackSigningSecretPrevious();
  const sig = req.headers['x-slack-signature'];
  const tsHdr = req.headers['x-slack-request-timestamp'];
  const sigStr = isHeaderString(sig) ? sig : null;
  const tsStr = isHeaderString(tsHdr) ? tsHdr : null;
  if (sigStr === null || tsStr === null) {
    closeIfBodyUnread(request);
    throw new HttpError(401, 'invalid Slack signature');
  }
  const rawBody = await readWebhookBody(request);
  if (
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
  await routeSignedSlackPayload({ hippoRoot: opts.hippoRoot, store, res, rawBody, signature: sigStr, slackTimestamp: tsStr });
}

/** One signed request and where to answer it; every stage below parks into the DLQ through it. */
interface SignedSlackRequest {
  hippoRoot: string;
  store?: HippoStore;
  res: ServerResponse;
  rawBody: string;
  signature: string;
  slackTimestamp: string;
}

async function parkAndAck(
  d: SignedSlackRequest,
  park: { tenantId: string | null; teamId: string | null; error: string; bucket: DlqBucket },
): Promise<void> {
  const row = {
    tenantId: park.tenantId,
    teamId: park.teamId,
    rawPayload: d.rawBody,
    error: park.error,
    bucket: park.bucket,
    signature: d.signature,
    slackTimestamp: d.slackTimestamp,
  };
  await parkInDlq(slackDlq, d.hippoRoot, row, d.store);
  sendJson(d.res, 200, { ok: true, status: 'dlq' });
}

function teamIdInRawBody(rawBody: string): string | null {
  // Cheap regex extracts team_id from a (possibly malformed) raw body so the
  // DLQ row carries it for triage even when JSON.parse fails.
  const m = rawBody.match(/"team_id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** Answers Slack's URL-verification handshake; false when the payload is anything else. */
function answerUrlVerification(res: ServerResponse, body: JsonValue | undefined): boolean {
  if (isJsonObject(body)) {
    const bodyRecord = body;
    if (bodyRecord.type === 'url_verification') {
      sendJson(res, 200, {
        challenge: String(bodyRecord.challenge ?? ''),
      });
      return true;
    }
  }
  return false;
}

async function routeSignedSlackPayload(d: SignedSlackRequest): Promise<void> {
  const { rawBody, res } = d;
  const teamIdFromRaw = teamIdInRawBody(rawBody);
  let body: JsonValue | undefined;
  try {
    body = JSON.parse(rawBody);
  } catch {
    await parkUnparseable(d, teamIdFromRaw);
    return;
  }
  if (answerUrlVerification(res, body)) return;
  // Fail closed: resolveTenantForSlackTeam returns null for an unknown team on a non-empty slack_workspaces; park it in slack_dlq (bucket='unroutable')
  // and still ACKs 200 so Slack stops retrying; never call ingest.
  let resolvedTenant: string | null = null;
  if (body !== undefined && isSlackEventEnvelope(body)) {
    resolvedTenant = await resolveTenantForSlackTeam(d.hippoRoot, body.team_id, d.store);
    if (resolvedTenant === null) {
      await parkAndAck(d, {
        tenantId: null, // unroutable - stored as '__unroutable__'
        teamId: body.team_id,
        error: `unroutable team_id: ${body.team_id}`,
        bucket: 'unroutable',
      });
      return;
    }
  } else {
    // Non-envelope payload: use env tenant for the DLQ row's bookkeeping.
    resolvedTenant = resolveTenantId({});
  }
  const ctx: Context = {
    hippoRoot: d.hippoRoot,
    tenantId: resolvedTenant,
    actor: { subject: 'connector:slack', role: 'admin' },
    store: d.store,
  };
  if (body === undefined || !isSlackEventEnvelope(body)) {
    await parkAndAck(d, {
      tenantId: ctx.tenantId,
      teamId: teamIdFromRaw,
      error: 'not an event_callback envelope',
      bucket: 'parse_error',
    });
    return;
  }
  await dispatchSlackEvent(d, ctx, body);
}

async function parkUnparseable(d: SignedSlackRequest, teamIdFromRaw: string | null): Promise<void> {
  // Attribute the parse failure to the originating workspace via the regex-extracted
  // team_id; a null or unknown team writes tenantId=null, which lands as '__unroutable__'.
  const parseFailTenant =
    teamIdFromRaw !== null ? await resolveTenantForSlackTeam(d.hippoRoot, teamIdFromRaw, d.store) : null;
  await parkAndAck(d, {
    tenantId: parseFailTenant, // null → '__unroutable__' sentinel
    teamId: teamIdFromRaw,
    error: 'invalid JSON',
    bucket: 'parse_error',
  });
}

async function dispatchSlackEvent(
  d: SignedSlackRequest,
  ctx: Context,
  body: JsonValue & SlackEventEnvelope,
): Promise<void> {
  const { res } = d;
  const inner = body.event;
  if (isSlackMessageEvent(inner)) {
    if (inner.subtype === 'message_deleted' && inner.deleted_ts) {
      const r = await handleMessageDeleted(ctx, {
        teamId: body.team_id,
        channelId: inner.channel,
        deletedTs: inner.deleted_ts,
        eventId: body.event_id,
      });
      sendJson(res, 200, { ok: true, status: r.status });
      return;
    }
    const r = await ingestMessage(ctx, {
      teamId: body.team_id,
      // Channel privacy is not on the inner event, so channel_type is the proxy: 'group'|'im'|'mpim' private, 'channel' public, unknown private.
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
  await parkAndAck(d, {
    tenantId: ctx.tenantId,
    teamId: body.team_id,
    error: `unhandled event type: ${inner.type ?? 'unknown'}`,
    bucket: 'parse_error',
  });
}
