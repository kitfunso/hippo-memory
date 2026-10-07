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
 * Source-aware idempotency key: artifact_ref plus the source-side updated_at.
 * A raw-body key would hash a webhook envelope and a REST backfill item of the
 * SAME source event differently and ingest it twice. Same artifact + same
 * revision = same key, whichever path delivered it; an edit gets a new key,
 * which is correct because each edit IS a new memory revision.
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
 */
export function computeIdempotencyKey(artifactRef: string, updatedAt: string | null | undefined): string {
  return createHash('sha256').update(`${artifactRef}:${updatedAt ?? ''}`).digest('hex');
}

/**
 * Deletion-specific idempotency key: sha256('deleted:' + artifactRef + ':' +
 * updatedAt). Distinct namespace from computeIdempotencyKey so an ingest's row
 * in github_event_log doesn't make a deletion return 'duplicate' before it
 * gets a chance to archive; retries of the SAME deletion still dedupe.
 *
 * Kept as a separate exported function so the namespace prefix is explicit
 * at every call site (server.ts deletion branches, deletion.ts, DLQ replay).
 */
export function computeDeletionKey(artifactRef: string, updatedAt: string | null | undefined): string {
  return createHash('sha256').update(`deleted:${artifactRef}:${updatedAt ?? ''}`).digest('hex');
}
