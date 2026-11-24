import { envCallerRps, envV1Rps } from '../../base/util/env.js';
import { log } from '../../base/util/log.js';
import { MINUTE_MS } from '../../base/util/time.js';
import { LIMITER_MAX_KEYS } from './rate-limit.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import type { RateLimitSpec, ServeOptions } from './types.js';

function limiterFor({ ratePerSec, burst }: RateLimitSpec): RateLimiter {
  return createRateLimiter({
    ratePerSec,
    burst,
    idleEvictMs: MINUTE_MS,
    maxKeys: LIMITER_MAX_KEYS,
  });
}

function bootRateLimiter(perAddress: RateLimitSpec | 'off' | undefined): RateLimiter | undefined {
  if (perAddress === 'off') return undefined;
  if (perAddress !== undefined) return limiterFor(perAddress);
  const raw = envV1Rps();
  const v1Rps = raw === undefined ? 20 : Number(raw);
  if (!Number.isFinite(v1Rps) || v1Rps < 0) {
    throw new Error(
      `HIPPO_V1_RPS must be a number of at least 0 (0 turns the per-address limit off), not '${raw}'`,
    );
  }
  if (v1Rps === 0) log.warn('HIPPO_V1_RPS=0: the per-address rate limit is off');
  return v1Rps > 0 ? limiterFor({ ratePerSec: v1Rps, burst: v1Rps * 2 }) : undefined;
}

const DEFAULT_FAILED_AUTH: RateLimitSpec = { ratePerSec: 20, burst: 40 };

function assertRateLimitSpec(name: string, { ratePerSec, burst }: RateLimitSpec): void {
  if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) {
    throw new Error(`rateLimits.${name}.ratePerSec must be a finite number above 0`);
  }
  if (!Number.isFinite(burst) || burst < 1) {
    throw new Error(`rateLimits.${name}.burst must be a finite number of at least 1`);
  }
}

export interface BootedLimiters {
  perAddress: RateLimiter | undefined;
  callerLimiter: RateLimiter | undefined;
  failedAuthLimiter: RateLimiter;
}

const DEFAULT_CALLER_RPS = 20;

function defaultCallerSpec(): RateLimitSpec | 'off' {
  const raw = envCallerRps();
  const rps = raw === undefined ? DEFAULT_CALLER_RPS : Number(raw);
  if (!Number.isFinite(rps) || rps < 0) {
    throw new Error(
      `HIPPO_CALLER_RPS must be a number of at least 0 (0 turns the per-caller limit off), not '${raw}'`,
    );
  }
  if (rps === 0) log.warn('HIPPO_CALLER_RPS=0: the per-caller rate limit is off');
  return rps === 0 ? 'off' : { ratePerSec: rps, burst: Math.max(1, rps * 2) };
}

/** Refuses a bad spec at boot, since a NaN or zero rate would otherwise turn a bucket off or
 * refuse every request. */
export function bootLimiters(rateLimits: ServeOptions['rateLimits']): BootedLimiters {
  const {
    perCaller = defaultCallerSpec(),
    perAddress,
    failedAuthPerAddress = DEFAULT_FAILED_AUTH,
  } = rateLimits ?? {};
  if (perCaller !== 'off') assertRateLimitSpec('perCaller', perCaller);
  if (perAddress !== undefined && perAddress !== 'off') {
    assertRateLimitSpec('perAddress', perAddress);
  }
  assertRateLimitSpec('failedAuthPerAddress', failedAuthPerAddress);
  return {
    perAddress: bootRateLimiter(perAddress),
    callerLimiter: perCaller === 'off' ? undefined : limiterFor(perCaller),
    failedAuthLimiter: limiterFor(failedAuthPerAddress),
  };
}
