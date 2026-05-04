import { createHmac, createHash, timingSafeEqual } from 'crypto';

export interface VerifyOpts {
  rawBody: string;
  /** Value of X-Hub-Signature-256, e.g. 'sha256=ab12...' */
  signature: string;
  webhookSecret: string;
  /** Previous secret for rotation parity with Slack. Optional. */
  previousSecret?: string;
}

function verifyOne(rawBody: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyGitHubSignature(opts: VerifyOpts): boolean {
  if (verifyOne(opts.rawBody, opts.signature, opts.webhookSecret)) return true;
  if (opts.previousSecret && verifyOne(opts.rawBody, opts.signature, opts.previousSecret)) return true;
  return false;
}

/**
 * Source-aware idempotency key. v1.3.1 hotfix (codex round 1 P0 #3 + claude
 * round 2 P0 #3).
 *
 * Round 1 design: sha256(eventName + ':' + rawBody) so an attacker rotating
 * X-GitHub-Delivery cannot bypass dedupe.
 *
 * Round 2 found that key produced different hashes for the SAME source event
 * delivered via webhook vs via REST backfill, because backfill rawBody is the
 * REST list-item shape while webhook rawBody is the envelope. Result:
 * backfill + later webhook of the same issue created two `kind='raw'` rows
 * with the same artifact_ref. Combined with the deletion bug, deletion could
 * not archive both.
 *
 * v1.3.1 fix: key from the SOURCE-NORMALIZED identifier — artifact_ref plus
 * the source-side updated_at timestamp. Same artifact + same revision = same
 * key, regardless of which path delivered it. Different revisions of the same
 * issue (an edit) get different keys, which is correct: each edit IS a new
 * memory revision.
 *
 * Both inputs are upstream-derived from the parsed event, not from the
 * unsigned delivery header — replay attacks still cannot bypass dedupe.
 *
 * Inputs:
 *   - artifactRef: e.g. 'github://acme/repo/issue/42' or
 *     'github://acme/repo/issue/42/comment/123'.
 *   - updatedAt: source-side ISO timestamp (issue.updated_at,
 *     comment.updated_at, pull_request.updated_at). Empty string when the
 *     payload omits it (rare; older REST shapes).
 *
 * Migration note for v1.3.0 → v1.3.1: existing github_event_log rows from
 * v1.3.0 used the round-1 key shape and will not collide with v1.3.1 keys.
 * The first webhook delivery after upgrading creates a new log row with the
 * new key. This is acceptable for a hotfix (no production users on v1.3.0)
 * and correct semantics going forward.
 */
export function computeIdempotencyKey(artifactRef: string, updatedAt: string | null | undefined): string {
  return createHash('sha256').update(`${artifactRef}:${updatedAt ?? ''}`).digest('hex');
}
