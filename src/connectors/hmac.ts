import { createHmac, timingSafeEqual } from 'crypto';

/** Timing-safe compare of `<prefix><hex HMAC-SHA256 of payload>` against the header a webhook sender supplied. */
export function matchesHmacSha256(prefix: string, payload: string, secret: string, signature: string): boolean {
  if (!signature.startsWith(prefix)) return false;
  const expected = `${prefix}${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
