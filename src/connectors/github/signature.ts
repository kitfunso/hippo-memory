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
 * Replay-safe idempotency key (codex P0 #3).
 *
 * GitHub does NOT sign X-GitHub-Delivery, so an attacker who captures one
 * signed payload can replay the body with any new delivery UUID. Deriving
 * idempotency from the delivery_id is unsafe.
 *
 * Key = sha256(eventName + ':' + rawBody). Both inputs are tamper-evident:
 *   - eventName comes from X-GitHub-Event, gated by upstream type guards.
 *   - rawBody is signed by the HMAC.
 * A valid replay of (eventName, body) IS the same event. delivery_id is kept
 * as audit metadata only, not as the dedupe seam.
 */
export function computeIdempotencyKey(eventName: string, rawBody: string): string {
  return createHash('sha256').update(`${eventName}:${rawBody}`).digest('hex');
}
