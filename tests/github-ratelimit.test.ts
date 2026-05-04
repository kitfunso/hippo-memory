import { describe, it, expect } from 'vitest';
import { parseRateLimit } from '../src/connectors/github/ratelimit.js';

describe('parseRateLimit', () => {
  it('returns secondary rate-limit with Retry-After seconds on 429', () => {
    const info = parseRateLimit({ 'retry-after': '30' }, 429);
    expect(info).toEqual({ sleepSeconds: 30, reason: 'secondary' });
  });

  it('returns primary rate-limit when 403 + remaining=0, sleeping until reset', () => {
    const now = 1_000_000;
    const info = parseRateLimit(
      {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now + 60),
      },
      403,
      now,
    );
    expect(info).toEqual({ sleepSeconds: 60, reason: 'primary' });
  });

  it('returns reason=none on a 200 OK', () => {
    const info = parseRateLimit({}, 200);
    expect(info).toEqual({ sleepSeconds: 0, reason: 'none' });
  });

  it('defaults to 60s on 429 when Retry-After is missing', () => {
    const info = parseRateLimit({}, 429);
    expect(info).toEqual({ sleepSeconds: 60, reason: 'secondary' });
  });

  it('floors to 1s when reset is already in the past (clock skew)', () => {
    const now = 1_000_000;
    const info = parseRateLimit(
      {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now - 30),
      },
      403,
      now,
    );
    expect(info.reason).toBe('primary');
    expect(info.sleepSeconds).toBeGreaterThanOrEqual(1);
    expect(info.sleepSeconds).toBe(1);
  });
});
