import {
  envGitHubAllowUnknownInstallationFallback,
  envGitHubEnterpriseBareRefsHost,
  envGitHubEnterpriseUrl,
  envGitHubTrustedUserIds,
  envGitHubWebhookSecret,
  envGitHubWebhookSecretPrevious,
  envGitHubWebhookSecretPreviousUntil,
  envTenant,
} from '../../../base/util/env.js';
import type { ServerResponse } from 'node:http';
import { DAY_MS } from '../../../base/util/time.js';
import { isWellFormedGitHubSignature, verifyGitHubSignature } from './signature.js';
import { GITHUB_PREVIOUS, previousSecretInForce, warnIfOpenEnded } from '../previous-secret.js';
import {
  isGitHubWebhookEnvelope,
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
  type GitHubWebhookEnvelope,
} from './types.js';
import {
  githubEventRef,
  ingestEvent as ingestGitHubEvent,
  type IngestEvent as GitHubIngestEvent,
} from './ingest.js';
import {
  headerHost,
  hostMismatch,
  parseGitHubEnterpriseUrl,
  payloadHost,
  payloadMismatch,
  type GitHubSite,
} from './site.js';
import { handleCommentDeleted as handleGitHubCommentDeleted } from './deletion.js';
import { parkInDlq } from '../dlq.js';
import { githubDlq, type DlqBucket } from './dlq.js';
import { resolveTenant } from '../tenant-route.js';
import { computeDeletionKey as computeGitHubDeletionKey } from './signature.js';
import { HttpError } from '../../../base/errors/http-errors.js';
import {
  JSON_HEADERS,
  isHeaderString,
  closeIfBodyUnread,
  readWebhookBody,
  sendJson,
  type WebhookRequest,
} from '../../http/http-util.js';
import { type JsonValue, tryParseJson } from '../../../base/util/json.js';
import type { ConnectorContext, WebhookPorts } from '../ingest.js';
import { errorFields, log } from '../../../base/util/log.js';

/** GITHUB_WEBHOOK_SECRET_PREVIOUS while its rotation window is open, for the webhook and the DLQ
 * replay alike. */
export function githubPreviousSecret(): string | undefined {
  return previousSecretInForce(
    GITHUB_PREVIOUS,
    envGitHubWebhookSecretPrevious(),
    envGitHubWebhookSecretPreviousUntil(),
  );
}

/** The GitHub site GITHUB_ENTERPRISE_URL names, for the webhook, the backfill and the DLQ replay
 * alike; throws on a value that is not a GHES root URL. */
export function githubSiteFromEnv(): GitHubSite {
  return parseGitHubEnterpriseUrl(envGitHubEnterpriseUrl(), envGitHubEnterpriseBareRefsHost());
}

export function warnGitHubPreviousSecretOpen(): void {
  warnIfOpenEnded(
    GITHUB_PREVIOUS,
    envGitHubWebhookSecretPrevious(),
    envGitHubWebhookSecretPreviousUntil(),
  );
}

const USER_ID = /^[1-9][0-9]*$/;

/** GITHUB_TRUSTED_USER_IDS for the webhook, the DLQ replay and backfill alike. It throws on an entry that is
 * not an id, such as a login: dropping it would hold the person the operator meant to trust. */
export function githubTrustedUserIds(): ReadonlySet<number> {
  const entries = (envGitHubTrustedUserIds() ?? '').split(',').map((entry) => entry.trim());
  const bad = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.length > 0)
    .filter(({ entry }) => !USER_ID.test(entry) || !Number.isSafeInteger(Number(entry)));
  if (bad.length > 0) {
    // No entry is quoted: any of them may be a secret pasted into the wrong variable.
    const named = bad.map(({ index }) => `entry ${index + 1}`).join(', ');
    throw new Error(
      `GITHUB_TRUSTED_USER_IDS has entries that are not numeric GitHub user ids: ${named}; ` +
        'get each id with: gh api users/<login> --jq .id',
    );
  }
  return new Set(entries.filter((entry) => entry.length > 0).map(Number));
}

/** Reads the raw body and refuses it unless the signature matches the current or the previous
 * secret. */
async function readSignedBody(
  request: WebhookRequest,
  secret: string,
  sigStr: string,
): Promise<string> {
  const rawBytes = await readWebhookBody(request);
  const previousSecret = githubPreviousSecret();
  if (
    !verifyGitHubSignature({
      rawBody: rawBytes,
      signature: sigStr,
      webhookSecret: secret,
      previousSecret,
    })
  ) {
    throw new HttpError(401, 'invalid GitHub signature');
  }
  return rawBytes.toString('utf8');
}

/** GitHub webhook receiver: HMAC SHA-256 over the raw body, event type from the X-GitHub-Event header, tenant by
 *  installation.id then repository.full_name. ACKs 200 on signed envelopes (DLQ too); 401 only on a bad signature; 409
 *  on a replayed delivery id; 404 if GITHUB_WEBHOOK_SECRET is unset. No Bearer: route auth is webhook-signature. */
export async function handleGitHubEventsWebhook(
  request: WebhookRequest,
  ports: WebhookPorts,
): Promise<void> {
  const { req, res, opts } = request;
  // Secret and signature header before the body, so a caller with neither cannot make the server
  // buffer one.
  const secret = envGitHubWebhookSecret();
  if (!secret) return refuseUnconfigured(request);
  const { sigStr, eventName, deliveryId, enterpriseHost } = readGitHubHeaders(req);

  if (sigStr === null || !isWellFormedGitHubSignature(sigStr)) {
    closeIfBodyUnread(request);
    throw new HttpError(401, 'invalid GitHub signature');
  }
  const rawBody = await readSignedBody(request, secret, sigStr);

  // Signature OK from here on. Everything else is ACK-200; bad envelopes go to the DLQ and a human
  // can replay later. The delivery id header is unsigned, so a captured body resent under a fresh
  // id must still hit the same hold.
  const replayKey = sigStr;
  await claimOrRefuse(ports.store, replayKey);
  try {
    await routeSignedDelivery({
      hippoRoot: opts.hippoRoot,
      ...ports,
      res,
      rawBody,
      eventName,
      deliveryId,
      enterpriseHost,
      site: githubSiteFromEnv(),
      signature: sigStr,
    });
  } catch (err) {
    // A delivery that failed left nothing stored, so GitHub's redelivery of the same id must get
    // through.
    await freeHold(ports.store, replayKey);
    throw err;
  }
}

function refuseUnconfigured(request: WebhookRequest): void {
  closeIfBodyUnread(request);
  request.res.writeHead(404, JSON_HEADERS);
  request.res.end(JSON.stringify({ error: 'not found' }));
}

/** Each GitHub header, or null unless it came as a single string. */
interface GitHubHeaders {
  readonly sigStr: string | null;
  readonly eventName: string | null;
  readonly deliveryId: string | null;
  readonly enterpriseHost: string | null;
}

function readGitHubHeaders(req: WebhookRequest['req']): GitHubHeaders {
  const sigHdr = req.headers['x-hub-signature-256'];
  const eventHdr = req.headers['x-github-event'];
  const deliveryHdr = req.headers['x-github-delivery'];
  const enterpriseHdr = req.headers['x-github-enterprise-host'];
  return {
    sigStr: isHeaderString(sigHdr) ? sigHdr : null,
    eventName: isHeaderString(eventHdr) ? eventHdr : null,
    deliveryId: isHeaderString(deliveryHdr) ? deliveryHdr : null,
    enterpriseHost: isHeaderString(enterpriseHdr) ? enterpriseHdr : null,
  };
}

// GitHub signs no timestamp, so a captured delivery verifies forever. The event log keeps each
// idempotency key for good, so the signature hold must not run out first: a century outlives any
// store, and the sweep never reaches it.
const REPLAY_HOLD_MS = 36_500 * DAY_MS;

async function claimOrRefuse(store: WebhookPorts['store'], key: string): Promise<void> {
  const claim = { connector: 'github', key, nowMs: Date.now(), ttlMs: REPLAY_HOLD_MS } as const;
  if (!(await store.connectorEvents.claimDelivery(claim))) {
    throw new HttpError(409, 'duplicate X-GitHub-Delivery');
  }
}

async function freeHold(store: WebhookPorts['store'], key: string): Promise<void> {
  await store.connectorEvents.releaseDelivery('github', key).catch((err) => {
    log.warn(
      'github webhook: could not free the replay hold of a failed delivery',
      errorFields(err),
    );
  });
}

const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review_comment',
]);

type SignedEnvelope = JsonValue & GitHubWebhookEnvelope;

/** One signed request and where to answer it; every stage below parks into the DLQ through it. */
interface SignedDelivery extends WebhookPorts {
  hippoRoot: string;
  res: ServerResponse;
  rawBody: string;
  eventName: string | null;
  deliveryId: string | null;
  enterpriseHost: string | null;
  site: GitHubSite;
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

function routingOf(body: SignedEnvelope): DlqRouting {
  return {
    installationId: body.installation?.id != null ? String(body.installation.id) : null,
    repoFullName: body.repository?.full_name ?? null,
  };
}

let warnedEnterpriseUnset = false;

/** Parks a delivery from a server the set GITHUB_ENTERPRISE_URL does not name, by its header or by
 * the repository URL its signed payload carries; true when it did. With the setting unset, a GHES
 * delivery gets through and one warning per process says its keys carry no host. */
async function parkedForHost(d: SignedDelivery): Promise<boolean> {
  const sent = headerHost(d.enterpriseHost);
  if (d.site.host === undefined) {
    // Nothing parks without a host, so no parse here; parseEnvelopeOrPark parses the body once.
    if (sent !== undefined && !warnedEnterpriseUnset) {
      warnedEnterpriseUnset = true;
      log.warn(
        `GitHub Enterprise delivery from ${sent}, but GITHUB_ENTERPRISE_URL is unset; ` +
          'its refs, tags and scope carry no host',
      );
    }
    return false;
  }
  const parsed = tryParseJson(d.rawBody);
  // A payload with no repository URL passes: the header it matched already names the server.
  const payloadSays = payloadHost(parsed);
  const error =
    hostMismatch(sent, d.site) ??
    (payloadSays === undefined ? null : payloadMismatch(sent, payloadSays, d.site));
  if (error === null) return false;
  // A parked delivery still answers 200, so this line is how an operator sees intake stop.
  log.warn(`github webhook: parked delivery ${d.deliveryId ?? '-'} as host_mismatch: ${error}`);
  const body = parsed !== undefined && isGitHubWebhookEnvelope(parsed) ? parsed : null;
  const routing: DlqRouting =
    body === null ? { installationId: null, repoFullName: null } : routingOf(body);
  const tenantId = body === null ? envTenant() : await resolveGitHubTenant(d, routing);
  await parkAndAck(d, { ...routing, tenantId, error, bucket: 'host_mismatch' });
  return true;
}

async function routeSignedDelivery(d: SignedDelivery): Promise<void> {
  // First of every park, so a delivery from the wrong server never parks as unroutable or
  // parse_error, which a replay could then store under this server's keys.
  if (d.eventName !== 'ping' && (await parkedForHost(d))) return;

  const body = await parseEnvelopeOrPark(d);
  if (body === null || d.deliveryId === null) return;

  const routing = routingOf(body);

  const resolvedTenant = await resolveGitHubTenant(d, routing);
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
    tenantId: resolvedTenant,
    actor: { subject: 'connector:github', role: 'admin' },
    store: d.store,
    config: d.config,
    infra: d.infra,
  };
  if (await dispatchGitHubEvent({ d, ctx, body, deliveryId: d.deliveryId, routing })) return;

  // Header allow-listed but body shape didn't satisfy the matching guard.
  await parkAndAck(d, {
    ...routing,
    tenantId: resolvedTenant,
    error: `body shape did not match X-GitHub-Event=${d.eventName}`,
    bucket: 'parse_error',
  });
}

// Fail closed on multi-tenant installs with unknown routing - same policy as Slack.
function resolveGitHubTenant(d: SignedDelivery, routing: DlqRouting): Promise<string | null> {
  return resolveTenant(
    d.store,
    { connector: 'github', ...routing },
    {
      hostTenant: envTenant(),
      allowUnknown: envGitHubAllowUnknownInstallationFallback(),
    },
  );
}

/** Answers ping and parks every unusable body; returns the envelope only when ingest should go
 * on. */
async function parseEnvelopeOrPark(d: SignedDelivery): Promise<SignedEnvelope | null> {
  // Cheap regex extraction of installation_id / repo for DLQ rows that fail to JSON.parse - gives
  // operators something to triage.
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
      tenantId: envTenant(),
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

  const body = tryParseJson(d.rawBody);
  if (body === undefined) return parkRaw('invalid JSON', 'parse_error');

  if (!isGitHubWebhookEnvelope(body)) {
    return parkRaw('not a GitHub webhook envelope', 'parse_error');
  }
  return body;
}

interface DispatchGitHubEventOptions {
  readonly d: SignedDelivery;
  readonly ctx: ConnectorContext;
  readonly body: SignedEnvelope;
  readonly deliveryId: string;
  readonly routing: DlqRouting;
}

/** Ingests, archives or parks by event header; false when no guard matched the body. */
async function dispatchGitHubEvent({
  d,
  ctx,
  body,
  deliveryId,
  routing,
}: DispatchGitHubEventOptions): Promise<boolean> {
  const action = deliveryAction(d.eventName, body, d.site.host);
  if (action === null) return false;

  if (action.kind === 'manual-review') {
    // issues.deleted (admin-initiated) is logged, not archived: archiving could lose the memory if
    // the issue moves between accounts.
    await parkAndAck(d, {
      ...routing,
      tenantId: ctx.tenantId,
      error: 'issues.deleted requires manual review',
      bucket: 'unhandled',
    });
  } else if (action.kind === 'archive-comment') {
    // The "deleted:" key namespace keeps this from colliding with the ingest key for the same
    // artifact; a shared key would make hasSeenKey skip the archive.
    const idempotencyKey = computeGitHubDeletionKey(action.artifactRef, action.updatedAt);
    const r = await handleGitHubCommentDeleted(ctx, {
      artifactRef: action.artifactRef,
      idempotencyKey,
      deliveryId,
      eventName: action.eventName,
      ownsBareRefs: d.site.ownsBareRefs,
    });
    sendJson(d.res, 200, { ok: true, status: r.status, archivedCount: r.archivedCount });
  } else {
    const r = await ingestGitHubEvent(ctx, {
      event: action.event,
      rawBody: d.rawBody,
      deliveryId,
      host: d.site.host,
      ownsBareRefs: d.site.ownsBareRefs,
      trustedUserIds: githubTrustedUserIds(),
    });
    sendJson(d.res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
  }
  return true;
}

/** What a signed delivery asks for once its body has matched its event header. */
type DeliveryAction =
  | { kind: 'ingest'; event: GitHubIngestEvent }
  | { kind: 'archive-comment'; eventName: string; artifactRef: string; updatedAt: string | null }
  | { kind: 'manual-review' };

// Dispatch by event header. Type guards cross-check the body shape against the header so a payload
// of one event type cannot satisfy another's guard.
function deliveryAction(
  eventName: string | null,
  body: SignedEnvelope,
  host: string | undefined,
): DeliveryAction | null {
  if (eventName === 'issues' && isGitHubIssueEvent(body, 'issues')) {
    if (body.action === 'deleted') return { kind: 'manual-review' };
    return { kind: 'ingest', event: { eventName: 'issues', payload: body } };
  }

  if (eventName === 'issue_comment' && isGitHubIssueCommentEvent(body, 'issue_comment')) {
    if (body.action === 'deleted') {
      const artifactRef = githubEventRef({ eventName: 'issue_comment', payload: body }, host);
      return {
        kind: 'archive-comment',
        eventName,
        artifactRef,
        updatedAt: body.comment.updated_at ?? null,
      };
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
      const artifactRef = githubEventRef(
        { eventName: 'pull_request_review_comment', payload: body },
        host,
      );
      // Same "deleted:" key namespace as the issue_comment branch above.
      return {
        kind: 'archive-comment',
        eventName,
        artifactRef,
        updatedAt: body.comment.updated_at ?? null,
      };
    }
    return { kind: 'ingest', event: { eventName: 'pull_request_review_comment', payload: body } };
  }
  return null;
}
