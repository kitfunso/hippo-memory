/**
 * GitHub event ingest with afterWrite race-safe idempotency.
 *
 * Mirrors src/connectors/slack/ingest.ts. The dedupe key is sha256(eventName +
 * ':' + rawBody) (codex P0 #3) — derived from the signed body, not from the
 * unsigned X-GitHub-Delivery header, so a replay attacker cannot bypass
 * idempotency by rotating the delivery UUID.
 *
 * Race semantics (codex P1 #6):
 *   - Fast path: hasSeenKey pre-check returns 'duplicate' for the common case.
 *   - Slow path: hasSeenKey passes (no row yet). Two workers may race into
 *     remember() concurrently. Inside the writeEntry SAVEPOINT, INSERT OR
 *     IGNORE on github_event_log either inserts (changes=1, commit) or
 *     collides (changes=0, throw DuplicateIdempotencyError -> SAVEPOINT
 *     rolls back this worker's memory row). Exactly one memory exists per
 *     idempotency_key.
 *
 * The Slack precedent's race test was insufficient — it tested the fast path,
 * not the SAVEPOINT collision. The `__testInjectBeforeLog` hook below lets
 * tests pre-populate github_event_log inside the SAVEPOINT to actually
 * exercise the changes=0 -> rollback path.
 */

import { remember, type Context, type RememberOpts } from '../../api.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../db.js';
import { hasSeenKey, lookupMemoryByKey, DuplicateIdempotencyError } from './idempotency.js';
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
  /** The raw HTTP body — used for the idempotency key (replay-safe per codex P0 #3). */
  rawBody: string;
  /** X-GitHub-Delivery header value, audit metadata only. */
  deliveryId: string;
  /**
   * Test-only hook fired inside the SAVEPOINT, AFTER the memory row is
   * inserted but BEFORE the github_event_log INSERT OR IGNORE. Tests pass
   * a function that pre-inserts the github_event_log row using the
   * provided db handle to simulate a concurrent worker winning the race.
   * Production callers leave this undefined.
   */
  __testInjectBeforeLog?: (db: DatabaseSyncLike, idempotencyKey: string) => void;
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

export function ingestEvent(ctx: Context, input: IngestInput): IngestResult {
  const idempotencyKey = computeIdempotencyKey(input.event.eventName, input.rawBody);

  // Fast path: pre-check. Avoids running the transform / opening a write tx
  // for the common already-seen case (GitHub auto-retries with the same body).
  const db = openHippoDb(ctx.hippoRoot);
  try {
    if (hasSeenKey(db, idempotencyKey)) {
      return { status: 'duplicate', memoryId: lookupMemoryByKey(db, idempotencyKey) };
    }
  } finally {
    closeHippoDb(db);
  }

  const opts = transformEvent(input.event);

  if (!opts) {
    // Empty body: no memory to write, but mark seen so a retry of the same
    // empty event returns 'duplicate' (not 'skipped' again — that would
    // re-run the transform on every retry).
    const db2 = openHippoDb(ctx.hippoRoot);
    try {
      db2
        .prepare(
          `INSERT OR IGNORE INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(idempotencyKey, input.deliveryId, input.event.eventName, new Date().toISOString(), null);
    } finally {
      closeHippoDb(db2);
    }
    return { status: 'skipped', memoryId: null };
  }

  // Atomic write via afterWrite. Inside writeEntry's SAVEPOINT:
  //   1. memories row INSERT lands.
  //   2. (test-only) __testInjectBeforeLog can race-inject a colliding key.
  //   3. INSERT OR IGNORE on github_event_log; if a concurrent worker (or
  //      the test injection) beat us, changes=0 -> throw -> SAVEPOINT rolls
  //      back our memory row. Other worker's commit stands.
  try {
    const result = remember(
      { ...ctx, actor: ctx.actor || 'connector:github' },
      {
        ...opts,
        afterWrite: (innerDb, memoryId) => {
          if (input.__testInjectBeforeLog) {
            input.__testInjectBeforeLog(innerDb, idempotencyKey);
          }
          const inserted = innerDb
            .prepare(
              `INSERT OR IGNORE INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              idempotencyKey,
              input.deliveryId,
              input.event.eventName,
              new Date().toISOString(),
              memoryId,
            );
          if (Number(inserted.changes ?? 0) === 0) {
            throw new DuplicateIdempotencyError(idempotencyKey);
          }
        },
      },
    );
    return { status: 'ingested', memoryId: result.id };
  } catch (e) {
    if (e instanceof DuplicateIdempotencyError) {
      // Other worker's row is committed. Return its memory_id so callers
      // behave identically to the fast-path 'duplicate' branch.
      const db3 = openHippoDb(ctx.hippoRoot);
      try {
        return { status: 'skipped_duplicate', memoryId: lookupMemoryByKey(db3, idempotencyKey) };
      } finally {
        closeHippoDb(db3);
      }
    }
    throw e;
  }
}
