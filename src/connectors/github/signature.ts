import { createHash } from 'crypto';
import { matchesHmacSha256 } from '../hmac.js';

export interface VerifyOptions {
  /** The body's bytes as received; a string is hashed as its UTF-8 encoding. */
  rawBody: string | Uint8Array;
  /** Value of X-Hub-Signature-256, e.g. 'sha256=ab12...' */
  signature: string;
  webhookSecret: string;
  /** Previous secret for rotation parity with Slack. Optional. */
  previousSecret?: string;
}

const SIGNATURE_HEADER_RE = /^sha256=[0-9a-f]{64}$/;

/**
 * True for a header that could be a GitHub signature; anything else is refused before the body is read, since no secret
 * can make it match.
 */
export function isWellFormedGitHubSignature(signature: string): boolean {
  return SIGNATURE_HEADER_RE.test(signature);
}

function verifyOne(rawBody: string | Uint8Array, signature: string, secret: string): boolean {
  return matchesHmacSha256('sha256=', [rawBody], secret, signature);
}

export function verifyGitHubSignature(opts: VerifyOptions): boolean {
  if (verifyOne(opts.rawBody, opts.signature, opts.webhookSecret)) return true;
  if (opts.previousSecret && verifyOne(opts.rawBody, opts.signature, opts.previousSecret)) return true;
  return false;
}

/**
 * Source-aware idempotency key: artifact_ref plus the source-side updated_at, so a webhook and a REST backfill of the
 * SAME event dedupe.
 * An edit gets a new key (a new revision); both inputs come from the parsed event, not the unsigned delivery header, so
 * replays cannot bypass dedupe.
 */
export function computeIdempotencyKey(artifactRef: string, updatedAt: string | null | undefined): string {
  return createHash('sha256').update(`${artifactRef}:${updatedAt ?? ''}`).digest('hex');
}

/** Deletion idempotency key: sha256('deleted:' + artifactRef + ':' + updatedAt).
 * A separate namespace so an ingest's event-log row cannot make a deletion return 'duplicate'; retries of the same
 * deletion still dedupe.
 */
export function computeDeletionKey(artifactRef: string, updatedAt: string | null | undefined): string {
  return createHash('sha256').update(`deleted:${artifactRef}:${updatedAt ?? ''}`).digest('hex');
}
