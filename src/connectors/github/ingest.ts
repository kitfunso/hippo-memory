// GitHub event ingest, once per idempotency key. The key comes from the event's own content, never from the unsigned
// X-GitHub-Delivery header, so a replay cannot get past it by rotating the delivery id. The pre-check is only the fast path:
// the store logs the key in the memory's own transaction, which is what holds when two workers race.

import { remember, type Context, type RememberOpts } from '../../api.js';
import { requireGroup, storeFor } from '../../store-port.js';
import type { ConnectorEvent } from '../../store/port.js';
import { RejectedValueError } from '../../store/rejection.js';
import { computeIdempotencyKey } from './signature.js';
import {
  issueEventToRememberOpts,
  issueCommentEventToRememberOpts,
  pullRequestEventToRememberOpts,
  prReviewCommentEventToRememberOpts,
} from './transform.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
} from './types.js';

export type IngestStatus = 'ingested' | 'duplicate' | 'skipped' | 'skipped_duplicate';

export interface IngestResult {
  status: IngestStatus;
  memoryId: string | null;
}

/**
 * Discriminated union of the four event shapes V1 ingests. The eventName
 * field MUST equal the X-GitHub-Event header value; computeIdempotencyKey
 * folds it into the dedupe key so the same body posted under two different
 * X-GitHub-Event headers produces two distinct keys (test 7).
 */
export type IngestEvent =
  | { eventName: 'issues'; payload: GitHubIssueEvent }
  | { eventName: 'issue_comment'; payload: GitHubIssueCommentEvent }
  | { eventName: 'pull_request'; payload: GitHubPullRequestEvent }
  | { eventName: 'pull_request_review_comment'; payload: GitHubPullRequestReviewCommentEvent };

export interface IngestInput {
  /** The X-GitHub-Event header value + parsed body, discriminated. */
  event: IngestEvent;
  /** The raw HTTP body, used for the idempotency key (replay-safe). */
  rawBody: string;
  /** X-GitHub-Delivery header value, audit metadata only. */
  deliveryId: string;
}

function transformEvent(event: IngestEvent): RememberOpts | null {
  switch (event.eventName) {
    case 'issues':
      return issueEventToRememberOpts(event.payload);
    case 'issue_comment':
      return issueCommentEventToRememberOpts(event.payload);
    case 'pull_request':
      return pullRequestEventToRememberOpts(event.payload);
    case 'pull_request_review_comment':
      return prReviewCommentEventToRememberOpts(event.payload);
  }
}

/**
 * Extract the source-normalized identifier the idempotency key needs.
 * Backfill and webhook both produce IngestEvent objects describing the same
 * source revision, so deriving the key from these fields collapses both paths
 * onto the same dedupe row. Mirrors the artifactRef strings in transform.ts.
 */
function eventArtifactRef(event: IngestEvent): string {
  const repo = event.payload.repository?.full_name ?? 'unknown/unknown';
  switch (event.eventName) {
    case 'issues':
      return `github://${repo}/issue/${event.payload.issue.number}`;
    case 'issue_comment':
      return `github://${repo}/issue/${event.payload.issue.number}/comment/${event.payload.comment.id}`;
    case 'pull_request':
      return `github://${repo}/pull/${event.payload.pull_request.number}`;
    case 'pull_request_review_comment':
      return `github://${repo}/pull/${event.payload.pull_request.number}/review_comment/${event.payload.comment.id}`;
  }
}

function eventUpdatedAt(event: IngestEvent): string | null {
  switch (event.eventName) {
    case 'issues':
      return event.payload.issue.updated_at ?? null;
    case 'issue_comment':
      return event.payload.comment.updated_at ?? null;
    case 'pull_request':
      return event.payload.pull_request.updated_at ?? null;
    case 'pull_request_review_comment':
      return event.payload.comment.updated_at ?? null;
  }
}

export async function ingestEvent(ctx: Context, input: IngestInput): Promise<IngestResult> {
  const events = requireGroup(storeFor(ctx), 'connectorEvents');
  const idempotencyKey = computeIdempotencyKey(
    eventArtifactRef(input.event),
    eventUpdatedAt(input.event),
  );
  const event: ConnectorEvent = { connector: 'github', idempotencyKey, deliveryId: input.deliveryId, eventName: input.event.eventName };

  // Fast path: pre-check. Avoids running the transform / opening a write tx
  // for the common already-seen case (GitHub auto-retries with the same body).
  const seen = await events.eventRecord(event);
  if (seen.seen) return { status: 'duplicate', memoryId: seen.memoryId };

  const opts = transformEvent(input.event);

  if (!opts) {
    // Empty body: no memory to write, but mark seen so a retry of the same
    // empty event returns 'duplicate' (not 'skipped' again — that would
    // re-run the transform on every retry).
    await events.markEventSeen(event);
    return { status: 'skipped', memoryId: null };
  }

  try {
    return await rememberWithEventLog(ctx, event, opts);
  } catch (e) {
    if (e instanceof RejectedValueError) {
      // A tombstone hit is a PERMANENT skip, never DLQ-retried: mark the key seen like the empty-body
      // branch above so a GitHub retry of the same delivery acks as done, not error.
      await events.markEventSeen(event);
      return { status: 'skipped', memoryId: null };
    }
    throw e;
  }
}

async function rememberWithEventLog(ctx: Context, event: ConnectorEvent, opts: RememberOpts): Promise<IngestResult> {
  // No `|| 'connector:github'` fallback (see rememberWithEventLog in slack/ingest.ts for rationale).
  const result = await remember(ctx, { ...opts, untrusted: true, event });
  // Another worker logged this key between the pre-check and the write: its memory stands and ours was not stored.
  if (result.duplicate) return { status: 'skipped_duplicate', memoryId: result.duplicate.memoryId };
  return { status: 'ingested', memoryId: result.id };
}
