/** GitHub rate-limit header parser: 403 with `X-RateLimit-Remaining: 0` is primary, 429 with `Retry-After` is secondary.
 *  Backfill must pause and resume rather than error. */

export interface RateLimitInfo {
  readonly sleepSeconds: number;
  readonly reason: 'primary' | 'secondary' | 'none';
}

/** Parse the rate-limit signal from a GitHub response; `headers` are lower-cased and `now` (epoch seconds) is for deterministic tests. */
export function parseRateLimit(
  headers: Record<string, string | undefined>,
  status: number,
  now?: number,
): RateLimitInfo {
  const _now = now ?? Math.floor(Date.now() / 1000);

  if (status === 429) {
    const retry = Number(headers['retry-after'] ?? '60');
    return {
      sleepSeconds: Number.isFinite(retry) && retry >= 0 ? retry : 60,
      reason: 'secondary',
    };
  }

  if (status === 403 && Number(headers['x-ratelimit-remaining'] ?? '1') === 0) {
    const reset = Number(headers['x-ratelimit-reset'] ?? '0');
    const diff = reset - _now;
    return { sleepSeconds: Math.max(diff, 1), reason: 'primary' };
  }

  return { sleepSeconds: 0, reason: 'none' };
}
