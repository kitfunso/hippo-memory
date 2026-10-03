import { verifyGitHubSignature } from './signature.js';
import {
  isGitHubWebhookEnvelope,
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
} from './types.js';
import { ingestEvent as ingestGitHubEvent, type IngestEvent as GitHubIngestEvent } from './ingest.js';
import { handleCommentDeleted as handleGitHubCommentDeleted } from './deletion.js';
import { writeToDlq as writeToGitHubDlq } from './dlq.js';
import { resolveTenantForGitHub } from './tenant-routing.js';
import { computeDeletionKey as computeGitHubDeletionKey } from './signature.js';
import { resolveTenantId } from '../../tenant.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { adminActor, type Context } from '../../api.js';
import {
  HttpError,
  JSON_HEADERS,
  isHeaderString,
  readBody,
  sendJson,
  type JsonValue,
  type WebhookRequest,
} from '../../http-util.js';

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
export async function handleGitHubEventsWebhook({ req, res, opts }: WebhookRequest): Promise<void> {
  const rawBody = await readBody(req);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS;
  const sigHdr = req.headers['x-hub-signature-256'];
  const eventHdr = req.headers['x-github-event'];
  const deliveryHdr = req.headers['x-github-delivery'];
  const sigStr = isHeaderString(sigHdr) ? sigHdr : null;
  const eventName = isHeaderString(eventHdr) ? eventHdr : null;
  const deliveryId = isHeaderString(deliveryHdr) ? deliveryHdr : null;

  if (
    sigStr === null ||
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

  // Cheap regex extraction of installation_id / repo for DLQ rows that fail
  // to JSON.parse - gives operators something to triage.
  const installationFromRaw = (() => {
    const m = rawBody.match(/"installation"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/);
    return m ? m[1] : null;
  })();
  const repoFromRaw = (() => {
    const m = rawBody.match(/"full_name"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  })();

  if (deliveryId === null) {
    // Body was signed but caller omitted the audit header. Park.
    const db = openHippoDb(opts.hippoRoot);
    try {
      writeToGitHubDlq(db, {
        tenantId: resolveTenantId({}),
        rawPayload: rawBody,
        error: 'missing X-GitHub-Delivery header',
        bucket: 'parse_error',
        eventName,
        deliveryId: null,
        signature: sigStr,
        installationId: installationFromRaw,
        repoFullName: repoFromRaw,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }

  // Ping fires once at hook creation. Don't ingest, don't DLQ - just pong.
  if (eventName === 'ping') {
    sendJson(res, 200, { pong: true });
    return;
  }

  const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
    'issues',
    'issue_comment',
    'pull_request',
    'pull_request_review_comment',
  ]);
  if (eventName === null || !ALLOWED_EVENTS.has(eventName)) {
    const db = openHippoDb(opts.hippoRoot);
    try {
      writeToGitHubDlq(db, {
        tenantId: resolveTenantId({}),
        rawPayload: rawBody,
        error: `unhandled event: ${eventName ?? '(missing X-GitHub-Event)'}`,
        bucket: 'unhandled',
        eventName,
        deliveryId,
        signature: sigStr,
        installationId: installationFromRaw,
        repoFullName: repoFromRaw,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }

  let body: JsonValue | undefined;
  try {
    body = JSON.parse(rawBody);
  } catch {
    const db = openHippoDb(opts.hippoRoot);
    try {
      writeToGitHubDlq(db, {
        tenantId: resolveTenantId({}),
        rawPayload: rawBody,
        error: 'invalid JSON',
        bucket: 'parse_error',
        eventName,
        deliveryId,
        signature: sigStr,
        installationId: installationFromRaw,
        repoFullName: repoFromRaw,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }

  if (body === undefined || !isGitHubWebhookEnvelope(body)) {
    const db = openHippoDb(opts.hippoRoot);
    try {
      writeToGitHubDlq(db, {
        tenantId: resolveTenantId({}),
        rawPayload: rawBody,
        error: 'not a GitHub webhook envelope',
        bucket: 'parse_error',
        eventName,
        deliveryId,
        signature: sigStr,
        installationId: installationFromRaw,
        repoFullName: repoFromRaw,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }

  const installationId = body.installation?.id != null ? String(body.installation.id) : null;
  const repoFullName = body.repository?.full_name ?? null;

  // Tenant resolution. Fail closed on multi-tenant installs with unknown
  // routing - same policy as Slack.
  let resolvedTenant: string | null;
  {
    const db = openHippoDb(opts.hippoRoot);
    try {
      resolvedTenant = resolveTenantForGitHub(db, {
        installationId,
        repoFullName,
      });
    } finally {
      closeHippoDb(db);
    }
  }
  if (resolvedTenant === null) {
    const db = openHippoDb(opts.hippoRoot);
    try {
      writeToGitHubDlq(db, {
        tenantId: null,
        rawPayload: rawBody,
        error: `unroutable: installation_id=${installationId ?? '(none)'} repo=${repoFullName ?? '(none)'}`,
        bucket: 'unroutable',
        eventName,
        deliveryId,
        signature: sigStr,
        installationId,
        repoFullName,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }

  const ctx: Context = {
    hippoRoot: opts.hippoRoot,
    tenantId: resolvedTenant,
    actor: adminActor('connector:github'),
  };

  // Dispatch by event header. Type guards cross-check the body shape against
  // the header so a payload of one event type cannot satisfy another's guard.
  if (eventName === 'issues' && isGitHubIssueEvent(body, 'issues')) {
    if (body.action === 'deleted') {
      // GitHub does fire issues.deleted (admin-initiated). Don't archive - V1
      // policy is to log and let an operator decide. Archive could lose the
      // memory if the issue is being moved between accounts.
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToGitHubDlq(db, {
          tenantId: resolvedTenant,
          rawPayload: rawBody,
          error: 'issues.deleted requires manual review',
          bucket: 'unhandled',
          eventName,
          deliveryId,
          signature: sigStr,
          installationId,
          repoFullName,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }
    const ingestInput: GitHubIngestEvent = { eventName: 'issues', payload: body };
    const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
    sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
    return;
  }

  if (eventName === 'issue_comment' && isGitHubIssueCommentEvent(body, 'issue_comment')) {
    if (body.action === 'deleted') {
      const repo = body.repository?.full_name ?? '';
      const artifactRef = `github://${repo}/issue/${body.issue.number}/comment/${body.comment.id}`;
      // The "deleted:" key namespace keeps this from colliding with the ingest key for the
      // same artifact; a shared key would make hasSeenKey skip the archive.
      const idempotencyKey = computeGitHubDeletionKey(artifactRef, body.comment.updated_at ?? null);
      const r = handleGitHubCommentDeleted(ctx, {
        artifactRef,
        idempotencyKey,
        deliveryId,
        eventName,
      });
      sendJson(res, 200, { ok: true, status: r.status, archivedCount: r.archivedCount });
      return;
    }
    const ingestInput: GitHubIngestEvent = { eventName: 'issue_comment', payload: body };
    const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
    sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
    return;
  }

  if (eventName === 'pull_request' && isGitHubPullRequestEvent(body, 'pull_request')) {
    const ingestInput: GitHubIngestEvent = { eventName: 'pull_request', payload: body };
    const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
    sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
    return;
  }

  if (
    eventName === 'pull_request_review_comment' &&
    isGitHubPullRequestReviewCommentEvent(body, 'pull_request_review_comment')
  ) {
    if (body.action === 'deleted') {
      const repo = body.repository?.full_name ?? '';
      const artifactRef = `github://${repo}/pull/${body.pull_request.number}/review_comment/${body.comment.id}`;
      // Same "deleted:" key namespace as the issue_comment branch above.
      const idempotencyKey = computeGitHubDeletionKey(artifactRef, body.comment.updated_at ?? null);
      const r = handleGitHubCommentDeleted(ctx, {
        artifactRef,
        idempotencyKey,
        deliveryId,
        eventName,
      });
      sendJson(res, 200, { ok: true, status: r.status, archivedCount: r.archivedCount });
      return;
    }
    const ingestInput: GitHubIngestEvent = {
      eventName: 'pull_request_review_comment',
      payload: body,
    };
    const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
    sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
    return;
  }

  // Header allow-listed but body shape didn't satisfy the matching guard.
  {
    const db = openHippoDb(opts.hippoRoot);
    try {
      writeToGitHubDlq(db, {
        tenantId: resolvedTenant,
        rawPayload: rawBody,
        error: `body shape did not match X-GitHub-Event=${eventName}`,
        bucket: 'parse_error',
        eventName,
        deliveryId,
        signature: sigStr,
        installationId,
        repoFullName,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }
}
