import { createHmac, timingSafeEqual } from 'crypto';

export interface VerifyOpts {
  rawBody: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  /** Current unix seconds. Injectable for tests. */
  now?: number;
  /** Max allowed skew in seconds. Default 5 minutes (Slack's recommendation). */
  skewSeconds?: number;
}

export function verifySlackSignature(opts: VerifyOpts): boolean {
  const { rawBody, timestamp, signature, signingSecret } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 5 * 60;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > skew) return false;
  if (!signature.startsWith('v0=')) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
