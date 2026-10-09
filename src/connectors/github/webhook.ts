import { envGithubWebhookSecret, envGithubWebhookSecretPrevious } from '../../env.js';
import type { ServerResponse } from 'node:http';
import { verifyGitHubSignature } from './signature.js';
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
import { resolveTenantId } from '../../tenant.js';
import type { Context } from '../../api.js';
import {
  HttpError,
  JSON_HEADERS,
  isHeaderString,
  closeIfBodyUnread,
  readWebhookBody,
  sendJson,
  type WebhookRequest,
} from '../../http-util.js';
import type { JsonValue } from '../../json.js';

/**
 * GitHub webhook receiver. Mirrors the Slack route shape but with
 * GitHub-specific idioms:
 *   1. HMAC SHA-256 over the raw body (X-Hub-Signature-256), no timestamp.
 *   2. Event type discriminated by the X-GitHub-Event header (not body.type).
 *   3. X-GitHub-Delivery is required audit metadata (NOT the dedupe seam - see
 *      computeIdempotencyKey, which folds the signed body into the key so a
 *      replayed body with a fresh delivery UUID still dedupes).
 *   4. Tenant resolved by installation.id → github_installations, then by
 *      repository.full_name → github_repositories (PAT-mode multi-tenant).
 *   5. ALWAYS ACK 200 on signed envelopes (DLQ included). 401 only on bad
 *      signature; 404 only when GITHUB_WEBHOOK_SECRET is unset (don't expose
 *      the route's existence on builds where it's gated off).
 *
 * Bearer auth is skipped on purpose: server.ts checks isPublicRoute before calling this.
 */
export async function handleGitHubEventsWebhook(request: WebhookRequest): Promise<void> {
  const { req, res, opts } = request;
  // Secret and signature header before the body, so a caller with neither cannot make the server buffer one.
  const secret = envGithubWebhookSecret();
  if (!secret) {
    closeIfBodyUnread(request);
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const previousSecret = envGithubWebhookSecretPrevious();
  const sigHdr = req.headers['x-hub-signature-256'];
  const eventHdr = req.headers['x-github-event'];
  const deliveryHdr = req.headers['x-github-delivery'];
  const sigStr = isHeaderString(sigHdr) ? sigHdr : null;
  const eventName = isHeaderString(eventHdr) ? eventHdr : null;
  const deliveryId = isHeaderString(deliveryHdr) ? deliveryHdr : null;

  if (sigStr === null) {
    closeIfBodyUnread(request);
    throw new HttpError(401, 'invalid GitHub signature');
  }
  const rawBody = await readWebhookBody(request);
  if (
    !verifyGitHubSignature({
      rawBody,
      signature: sigStr,
      webhookSecret: secret,
      previousSecret,
    })
  ) {
    throw new HttpError(401, 'invalid GitHub signature');
  }

  // Signature OK from here on. Everything else is ACK-200; bad envelopes go
  // to the DLQ and a human can replay later.
  routeSignedDelivery({ hippoRoot: opts.hippoRoot, res, rawBody, eventName, deliveryId, signature: sigStr });
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

function parkAndAck(
  d: SignedDelivery,
  park: DlqRouting & { tenantId: string | null; error: string; bucket: DlqBucket },
): void {
  parkInDlq(githubDlq, d.hippoRoot, {
    tenantId: park.tenantId,
    rawPayload: d.rawBody,
    error: park.error,
    bucket: park.bucket,
    eventName: d.eventName,
    deliveryId: d.deliveryId,
    signature: d.signature,
    installationId: park.installationId,
    repoFullName: park.repoFullName,
  });
  sendJson(d.res, 200, { ok: true, status: 'dlq' });
}

function routeSignedDelivery(d: SignedDelivery): void {
  const body = parseEnvelopeOrPark(d);
  if (body === null || d.deliveryId === null) return;

  const routing: DlqRouting = {
    installationId: body.installation?.id != null ? String(body.installation.id) : null,
    repoFullName: body.repository?.full_name ?? null,
  };

  // Tenant resolution. Fail closed on multi-tenant installs with unknown
  // routing - same policy as Slack.
  const resolvedTenant = resolveTenantForGitHub(d.hippoRoot, routing);
  if (resolvedTenant === null) {
    parkAndAck(d, {
      ...routing,
      tenantId: null,
      error: `unroutable: installation_id=${routing.installationId ?? '(none)'} repo=${routing.repoFullName ?? '(none)'}`,
      bucket: 'unroutable',
    });
    return;
  }

  const ctx: Context = {
    hippoRoot: d.hippoRoot,
    tenantId: resolvedTenant,
    actor: { subject: 'connector:github', role: 'admin' },
  };
  if (dispatchGitHubEvent(d, ctx, body, d.deliveryId, routing)) return;

  // Header allow-listed but body shape didn't satisfy the matching guard.
  parkAndAck(d, {
    ...routing,
    tenantId: resolvedTenant,
    error: `body shape did not match X-GitHub-Event=${d.eventName}`,
    bucket: 'parse_error',
  });
}

/** Answers ping and parks every unusable body; returns the envelope only when ingest should go on. */
function parseEnvelopeOrPark(d: SignedDelivery): SignedEnvelope | null {
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
  const parkRaw = (error: string, bucket: DlqBucket): null => {
    parkAndAck(d, {
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
function dispatchGitHubEvent(
  d: SignedDelivery,
  ctx: Context,
  body: SignedEnvelope,
  deliveryId: string,
  routing: DlqRouting,
): boolean {
  const { res, rawBody, eventName } = d;
  const ingest = (event: GitHubIngestEvent): true => {
    const r = ingestGitHubEvent(ctx, { event, rawBody, deliveryId });
    sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
    return true;
  };
  const archiveComment = (event: string, artifactRef: string, updatedAt: string | null): true => {
    // The "deleted:" key namespace keeps this from colliding with the ingest key for the
    // same artifact; a shared key would make hasSeenKey skip the archive.
    const idempotencyKey = computeGitHubDeletionKey(artifactRef, updatedAt);
    const r = handleGitHubCommentDeleted(ctx, {
      artifactRef,
      idempotencyKey,
      deliveryId,
      eventName: event,
    });
    sendJson(res, 200, { ok: true, status: r.status, archivedCount: r.archivedCount });
    return true;
  };

  // Dispatch by event header. Type guards cross-check the body shape against
  // the header so a payload of one event type cannot satisfy another's guard.
  if (eventName === 'issues' && isGitHubIssueEvent(body, 'issues')) {
    if (body.action === 'deleted') {
      // GitHub does fire issues.deleted (admin-initiated). Don't archive - V1
      // policy is to log and let an operator decide. Archive could lose the
      // memory if the issue is being moved between accounts.
      parkAndAck(d, {
        ...routing,
        tenantId: ctx.tenantId,
        error: 'issues.deleted requires manual review',
        bucket: 'unhandled',
      });
      return true;
    }
    return ingest({ eventName: 'issues', payload: body });
  }

  if (eventName === 'issue_comment' && isGitHubIssueCommentEvent(body, 'issue_comment')) {
    if (body.action === 'deleted') {
      const repo = body.repository?.full_name ?? '';
      const artifactRef = `github://${repo}/issue/${body.issue.number}/comment/${body.comment.id}`;
      return archiveComment(eventName, artifactRef, body.comment.updated_at ?? null);
    }
    return ingest({ eventName: 'issue_comment', payload: body });
  }

  if (eventName === 'pull_request' && isGitHubPullRequestEvent(body, 'pull_request')) {
    return ingest({ eventName: 'pull_request', payload: body });
  }

  if (
    eventName === 'pull_request_review_comment' &&
    isGitHubPullRequestReviewCommentEvent(body, 'pull_request_review_comment')
  ) {
    if (body.action === 'deleted') {
      const repo = body.repository?.full_name ?? '';
      const artifactRef = `github://${repo}/pull/${body.pull_request.number}/review_comment/${body.comment.id}`;
      // Same "deleted:" key namespace as the issue_comment branch above.
      return archiveComment(eventName, artifactRef, body.comment.updated_at ?? null);
    }
    return ingest({ eventName: 'pull_request_review_comment', payload: body });
  }
  return false;
}
