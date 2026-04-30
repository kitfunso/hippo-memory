import { createHmac, timingSafeEqual } from 'crypto';

export interface VerifyOpts {
  rawBody: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  /**
   * Previous signing secret during a rotation. v0.39 commit 3: deploy with
   * both `SLACK_SIGNING_SECRET` (new) and `SLACK_SIGNING_SECRET_PREVIOUS` (old)
   * set, verify both work, drop previous after rollover. The verifier tries
   * `signingSecret` first, then `previousSecret` if that fails.
   */
  previousSecret?: string;
  /** Current unix seconds. Injectable for tests. */
  now?: number;
  /** Max allowed skew in seconds. Default 5 minutes (Slack's recommendation). */
  skewSeconds?: number;
}

function verifyOne(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string,
): boolean {
  if (!signature.startsWith('v0=')) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifySlackSignature(opts: VerifyOpts): boolean {
  const { rawBody, timestamp, signature, signingSecret, previousSecret } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 5 * 60;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > skew) return false;
  if (verifyOne(rawBody, signature, timestamp, signingSecret)) return true;
  if (previousSecret && verifyOne(rawBody, signature, timestamp, previousSecret)) return true;
  return false;
}
