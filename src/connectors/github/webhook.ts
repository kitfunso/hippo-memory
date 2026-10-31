import { envGitHubWebhookSecret, envGitHubWebhookSecretPrevious } from '../../util/env.js';
import type { ServerResponse } from 'node:http';
import { DAY_MS } from '../../util/time.js';
import { isWellFormedGitHubSignature, verifyGitHubSignature } from './signature.js';
import {
  isGitHubWebhookEnvelope,
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
  type GitHubWebhookEnvelope,
} from './types.js';
import { ingestEvent as ingestGitHubEvent, type IngestEvent as GitHubIngestEvent } from './ingest.js';
import { handleCommentDeleted as handleGitHubCommentDeleted } from './deletion.js';
import { parkInDlq } from '../dlq.js';
import { githubDlq, type DlqBucket } from './dlq.js';
import { resolveTenantForGitHub } from './tenant-routing.js';
import { computeDeletionKey as computeGitHubDeletionKey } from './signature.js';
import { resolveTenantId } from '../../store/tenant.js';
import type { ConnectorContext } from '../store.js';
import type { ConnectorStore } from '../store.js';
import {
  HttpError,
  JSON_HEADERS,
  isHeaderString,
  closeIfBodyUnread,
  readWebhookBody,
  sendJson,
  type WebhookRequest,
} from '../../util/http-util.js';
import type { JsonValue } from '../../util/json.js';

/** Reads the raw body and refuses it unless the signature matches the current or the previous secret. */
async function readSignedBody(request: WebhookRequest, secret: string, sigStr: string): Promise<string> {
  const rawBody = await readWebhookBody(request);
  const previousSecret = envGitHubWebhookSecretPrevious();
  if (!verifyGitHubSignature({ rawBody, signature: sigStr, webhookSecret: secret, previousSecret })) {
    throw new HttpError(401, 'invalid GitHub signature');
  }
  return rawBody;
}

/** GitHub webhook receiver: HMAC SHA-256 over the raw body, event type from the X-GitHub-Event header, tenant by
 *  installation.id then repository.full_name. ACKs 200 on signed envelopes (DLQ too); 401 only on a bad signature;
 *  409 on a replayed delivery id; 404 if GITHUB_WEBHOOK_SECRET is unset. No Bearer: route auth is webhook-signature. */
export async function handleGitHubEventsWebhook(request: WebhookRequest, store: ConnectorStore): Promise<void> {
  const { req, res, opts } = request;
  // Secret and signature header before the body, so a caller with neither cannot make the server buffer one.
  const secret = envGitHubWebhookSecret();
  if (!secret) {
    closeIfBodyUnread(request);
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const sigHdr = req.headers['x-hub-signature-256'];
  const eventHdr = req.headers['x-github-event'];
  const deliveryHdr = req.headers['x-github-delivery'];
  const sigStr = isHeaderString(sigHdr) ? sigHdr : null;
  const eventName = isHeaderString(eventHdr) ? eventHdr : null;
  const deliveryId = isHeaderString(deliveryHdr) ? deliveryHdr : null;

  if (sigStr === null || !isWellFormedGitHubSignature(sigStr)) {
    closeIfBodyUnread(request);
    throw new HttpError(401, 'invalid GitHub signature');
  }
  const rawBody = await readSignedBody(request, secret, sigStr);

  // Signature OK from here on. Everything else is ACK-200; bad envelopes go
  // to the DLQ and a human can replay later.
  const replayKey = deliveryId === null ? null : `${opts.hippoRoot}\n${deliveryId}`;
  if (replayKey !== null && !claimDelivery(replayKey, Date.now())) {
    throw new HttpError(409, 'duplicate X-GitHub-Delivery');
  }
  try {
    await routeSignedDelivery({
      hippoRoot: opts.hippoRoot,
      store,
      res,
      rawBody,
      eventName,
      deliveryId,
      signature: sigStr,
    });
  } catch (err) {
    // A delivery that failed left nothing stored, so GitHub's redelivery of the same id must get through.
    if (replayKey !== null) seenDeliveries.delete(replayKey);
    throw err;
  }
}

// GitHub signs no timestamp, so a captured delivery verifies forever; this window is what refuses its replay.
const DELIVERY_REPLAY_TTL_MS = DAY_MS;
const DELIVERY_REPLAY_MAX_IDS = 10_000;
// A fast path only: the durable dedupe is the connector event log's content-derived idempotency key (ingest.ts, and the
// deletion key below), so a replay after a restart or an eviction is a stored 'duplicate' with no new rows.
const seenDeliveries = new Map<string, number>();

/** Claims a delivery id for the window; false when it was claimed within the window already. The oldest claim goes
 * first at the cap. */
function claimDelivery(key: string, now: number): boolean {
  const seenAt = seenDeliveries.get(key);
  if (seenAt !== undefined && now - seenAt < DELIVERY_REPLAY_TTL_MS) return false;
  seenDeliveries.delete(key);
  if (seenDeliveries.size >= DELIVERY_REPLAY_MAX_IDS) {
    const oldest = seenDeliveries.keys().next();
    if (!oldest.done) seenDeliveries.delete(oldest.value);
  }
  seenDeliveries.set(key, now);
  return true;
}

const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review_comment',
]);

type SignedEnvelope = JsonValue & GitHubWebhookEnvelope;

/** One signed request and where to answer it; every stage below parks into the DLQ through it. */
interface SignedDelivery {
  hippoRoot: string;
  store: ConnectorStore;
  res: ServerResponse;
  rawBody: string;
  eventName: string | null;
  deliveryId: string | null;
  signature: string;
}

interface DlqRouting {
  installationId: string | null;
  repoFullName: string | null;
}

async function parkAndAck(
  d: SignedDelivery,
  park: DlqRouting & { tenantId: string | null; error: string; bucket: DlqBucket },
): Promise<void> {
  const row = {
    tenantId: park.tenantId,
    rawPayload: d.rawBody,
    error: park.error,
    bucket: park.bucket,
    eventName: d.eventName,
    deliveryId: d.deliveryId,
    signature: d.signature,
    installationId: park.installationId,
    repoFullName: park.repoFullName,
  };
  await parkInDlq(githubDlq, d.store, row);
  sendJson(d.res, 200, { ok: true, status: 'dlq' });
}

async function routeSignedDelivery(d: SignedDelivery): Promise<void> {
  const body = await parseEnvelopeOrPark(d);
  if (body === null || d.deliveryId === null) return;

  const routing: DlqRouting = {
    installationId: body.installation?.id != null ? String(body.installation.id) : null,
    repoFullName: body.repository?.full_name ?? null,
  };

  // Tenant resolution. Fail closed on multi-tenant installs with unknown
  // routing - same policy as Slack.
  const resolvedTenant = await resolveTenantForGitHub(d.store, routing);
  if (resolvedTenant === null) {
    await parkAndAck(d, {
      ...routing,
      tenantId: null,
      error: `unroutable: installation_id=${routing.installationId ?? '(none)'} repo=${routing.repoFullName ?? '(none)'}`,
      bucket: 'unroutable',
    });
    return;
  }

  const ctx: ConnectorContext = {
    hippoRoot: d.hippoRoot,
    tenantId: resolvedTenant,
    actor: { subject: 'connector:github', role: 'admin' },
    store: d.store,
  };
  if (await dispatchGitHubEvent(d, ctx, body, d.deliveryId, routing)) return;

  // Header allow-listed but body shape didn't satisfy the matching guard.
  await parkAndAck(d, {
    ...routing,
    tenantId: resolvedTenant,
    error: `body shape did not match X-GitHub-Event=${d.eventName}`,
    bucket: 'parse_error',
  });
}

/** Answers ping and parks every unusable body; returns the envelope only when ingest should go on. */
async function parseEnvelopeOrPark(d: SignedDelivery): Promise<SignedEnvelope | null> {
  // Cheap regex extraction of installation_id / repo for DLQ rows that fail
  // to JSON.parse - gives operators something to triage.
  const installationFromRaw = (() => {
    const m = d.rawBody.match(/"installation"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/);
    return m ? m[1] : null;
  })();
  const repoFromRaw = (() => {
    const m = d.rawBody.match(/"full_name"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  })();
  const parkRaw = async (error: string, bucket: DlqBucket): Promise<null> => {
    await parkAndAck(d, {
      tenantId: resolveTenantId({}),
      error,
      bucket,
      installationId: installationFromRaw,
      repoFullName: repoFromRaw,
    });
    return null;
  };

  // Body was signed but caller omitted the audit header. Park.
  if (d.deliveryId === null) return parkRaw('missing X-GitHub-Delivery header', 'parse_error');

  // Ping fires once at hook creation. Don't ingest, don't DLQ - just pong.
  if (d.eventName === 'ping') {
    sendJson(d.res, 200, { pong: true });
    return null;
  }

  if (d.eventName === null || !ALLOWED_EVENTS.has(d.eventName)) {
    return parkRaw(`unhandled event: ${d.eventName ?? '(missing X-GitHub-Event)'}`, 'unhandled');
  }

  let body: JsonValue | undefined;
  try {
    body = JSON.parse(d.rawBody);
  } catch {
    return parkRaw('invalid JSON', 'parse_error');
  }

  if (body === undefined || !isGitHubWebhookEnvelope(body)) {
    return parkRaw('not a GitHub webhook envelope', 'parse_error');
  }
  return body;
}

/** Ingests, archives or parks by event header; false when no guard matched the body. */
async function dispatchGitHubEvent(
  d: SignedDelivery,
  ctx: ConnectorContext,
  body: SignedEnvelope,
  deliveryId: string,
  routing: DlqRouting,
): Promise<boolean> {
  const action = deliveryAction(d.eventName, body);
  if (action === null) return false;

  if (action.kind === 'manual-review') {
    // issues.deleted (admin-initiated) is logged, not archived: archiving
    // could lose the memory if the issue moves between accounts.
    await parkAndAck(d, {
      ...routing,
      tenantId: ctx.tenantId,
      error: 'issues.deleted requires manual review',
      bucket: 'unhandled',
    });
  } else if (action.kind === 'archive-comment') {
    // The "deleted:" key namespace keeps this from colliding with the ingest key for the
    // same artifact; a shared key would make hasSeenKey skip the archive.
    const idempotencyKey = computeGitHubDeletionKey(action.artifactRef, action.updatedAt);
    const r = await handleGitHubCommentDeleted(ctx, {
      artifactRef: action.artifactRef,
      idempotencyKey,
      deliveryId,
      eventName: action.eventName,
    });
    sendJson(d.res, 200, { ok: true, status: r.status, archivedCount: r.archivedCount });
  } else {
    const r = await ingestGitHubEvent(ctx, { event: action.event, rawBody: d.rawBody, deliveryId });
    sendJson(d.res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
  }
  return true;
}

/** What a signed delivery asks for once its body has matched its event header. */
type DeliveryAction =
  | { kind: 'ingest'; event: GitHubIngestEvent }
  | { kind: 'archive-comment'; eventName: string; artifactRef: string; updatedAt: string | null }
  | { kind: 'manual-review' };

// Dispatch by event header. Type guards cross-check the body shape against
// the header so a payload of one event type cannot satisfy another's guard.
function deliveryAction(eventName: string | null, body: SignedEnvelope): DeliveryAction | null {
  if (eventName === 'issues' && isGitHubIssueEvent(body, 'issues')) {
    if (body.action === 'deleted') return { kind: 'manual-review' };
    return { kind: 'ingest', event: { eventName: 'issues', payload: body } };
  }

  if (eventName === 'issue_comment' && isGitHubIssueCommentEvent(body, 'issue_comment')) {
    if (body.action === 'deleted') {
      const repo = body.repository?.full_name ?? '';
      const artifactRef = `github://${repo}/issue/${body.issue.number}/comment/${body.comment.id}`;
      return { kind: 'archive-comment', eventName, artifactRef, updatedAt: body.comment.updated_at ?? null };
    }
    return { kind: 'ingest', event: { eventName: 'issue_comment', payload: body } };
  }

  if (eventName === 'pull_request' && isGitHubPullRequestEvent(body, 'pull_request')) {
    return { kind: 'ingest', event: { eventName: 'pull_request', payload: body } };
  }

  if (
    eventName === 'pull_request_review_comment' &&
    isGitHubPullRequestReviewCommentEvent(body, 'pull_request_review_comment')
  ) {
    if (body.action === 'deleted') {
      const repo = body.repository?.full_name ?? '';
      const artifactRef = `github://${repo}/pull/${body.pull_request.number}/review_comment/${body.comment.id}`;
      // Same "deleted:" key namespace as the issue_comment branch above.
      return { kind: 'archive-comment', eventName, artifactRef, updatedAt: body.comment.updated_at ?? null };
    }
    return { kind: 'ingest', event: { eventName: 'pull_request_review_comment', payload: body } };
  }
  return null;
}
