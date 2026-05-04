/**
 * GitHub rate-limit header parser.
 *
 * GitHub returns 403 for primary rate-limit (with `X-RateLimit-Remaining: 0`
 * and `X-RateLimit-Reset: <epoch>`) and 429 + `Retry-After: <seconds>` for
 * secondary rate-limit. Backfill must pause and resume rather than error.
 */

export interface RateLimitInfo {
  readonly sleepSeconds: number;
  readonly reason: 'primary' | 'secondary' | 'none';
}

/**
 * Parse rate-limit signal from a GitHub HTTP response.
 *
 * @param headers Lower-cased HTTP response headers.
 * @param status  HTTP status code.
 * @param now     Optional current epoch seconds (for deterministic tests).
 */
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
