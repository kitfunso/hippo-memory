// GitHub event ingest, once per idempotency key. The key comes from the event's own content, never
// from the unsigned X-GitHub-Delivery header, so a replay cannot get past it by rotating the
// delivery id. The pre-check is only the fast path: the store logs the key in the memory's own
// transaction, which is what holds when two workers race.

import type { RememberOptions } from '../../../api/index.js';
import type { ConnectorEvent } from '../../../base/ports/store.js';
import { rememberWithEventLog, type ConnectorContext, type IngestResult } from '../ingest.js';
import { githubArtifactRef, type GitHubItem } from './ref.js';
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

/** Discriminated union of the four event shapes V1 ingests; eventName MUST equal the X-GitHub-Event header, since
 *  computeIdempotencyKey folds it into the dedupe key. */
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
  /** GITHUB_ENTERPRISE_URL's host, which the ref, tags and scope carry; undefined on github.com. */
  host?: string;
}

function transformEvent(event: IngestEvent, host: string | undefined): RememberOptions | null {
  switch (event.eventName) {
    case 'issues':
      return issueEventToRememberOpts(event.payload, host);
    case 'issue_comment':
      return issueCommentEventToRememberOpts(event.payload, host);
    case 'pull_request':
      return pullRequestEventToRememberOpts(event.payload, host);
    case 'pull_request_review_comment':
      return prReviewCommentEventToRememberOpts(event.payload, host);
  }
}

function eventItem(event: IngestEvent): GitHubItem {
  switch (event.eventName) {
    case 'issues':
      return { kind: 'issue', number: event.payload.issue.number };
    case 'issue_comment':
      return {
        kind: 'issue_comment',
        number: event.payload.issue.number,
        commentId: event.payload.comment.id,
      };
    case 'pull_request':
      return { kind: 'pull', number: event.payload.pull_request.number };
    case 'pull_request_review_comment':
      return {
        kind: 'review_comment',
        number: event.payload.pull_request.number,
        commentId: event.payload.comment.id,
      };
  }
}

/** The event's artifact_ref: the one transform.ts stores, the dedupe key hashes and a comment
 * deletion looks up, so backfill and webhook deliveries of one revision collapse onto one row. */
export function githubEventRef(event: IngestEvent, host: string | undefined): string {
  return githubArtifactRef(event.payload.repository?.full_name, eventItem(event), host);
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

export async function ingestEvent(
  ctx: ConnectorContext,
  input: IngestInput,
): Promise<IngestResult> {
  const events = ctx.store.connectorEvents;
  const updatedAt = eventUpdatedAt(input.event);
  const event: ConnectorEvent = {
    connector: 'github',
    idempotencyKey: computeIdempotencyKey(githubEventRef(input.event, input.host), updatedAt),
    deliveryId: input.deliveryId,
    eventName: input.event.eventName,
  };

  // Fast path: pre-check. Avoids running the transform / opening a write tx for the common
  // already-seen case (GitHub auto-retries with the same body).
  const seen = await events.eventRecord(event);
  if (seen.seen) return { status: 'duplicate', memoryId: seen.memoryId };

  // A GHES webhook logged its items under github.com-form refs while the setting was unset.
  if (input.host !== undefined) {
    const legacyKey = computeIdempotencyKey(githubEventRef(input.event, undefined), updatedAt);
    const legacy = await events.eventRecord({ ...event, idempotencyKey: legacyKey });
    if (legacy.seen) return { status: 'duplicate', memoryId: legacy.memoryId };
  }

  // An empty body is logged too, so a retry returns 'duplicate' instead of re-running the
  // transform.
  return rememberWithEventLog(ctx, event, transformEvent(input.event, input.host));
}
