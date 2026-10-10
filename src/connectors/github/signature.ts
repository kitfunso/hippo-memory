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

/** Source-aware idempotency key: artifact_ref plus the source-side updated_at, so a webhook and a REST backfill of the SAME event dedupe.
 *  An edit gets a new key (a new revision); both inputs come from the parsed event, not the unsigned delivery header, so replays cannot bypass dedupe. */
export function computeIdempotencyKey(artifactRef: string, updatedAt: string | null | undefined): string {
  return createHash('sha256').update(`${artifactRef}:${updatedAt ?? ''}`).digest('hex');
}

/** Deletion idempotency key: sha256('deleted:' + artifactRef + ':' + updatedAt).
 *  A separate namespace so an ingest's event-log row cannot make a deletion return 'duplicate'; retries of the same deletion still dedupe. */
export function computeDeletionKey(artifactRef: string, updatedAt: string | null | undefined): string {
  return createHash('sha256').update(`deleted:${artifactRef}:${updatedAt ?? ''}`).digest('hex');
}
