import { createHmac, timingSafeEqual } from 'crypto';

/** Timing-safe compare of `<prefix><hex HMAC-SHA256 of the payload parts in order>` against the header a webhook sender
 * supplied; a byte part is hashed as sent, never decoded. */
export function matchesHmacSha256(
  prefix: string,
  payload: readonly (string | Uint8Array)[],
  secret: string,
  signature: string,
): boolean {
  if (!signature.startsWith(prefix)) return false;
  const hmac = createHmac('sha256', secret);
  for (const part of payload) hmac.update(part);
  const expected = `${prefix}${hmac.digest('hex')}`;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
