// A rate limit switched off by env says so at boot; one left on, or switched off in code, says nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../src/base/util/log.js';
import { bootLimiters } from '../../src/surface/server/rate-limits.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function warnsFor(env: Record<string, string>, rateLimits?: Parameters<typeof bootLimiters>[0]): string[] {
  vi.stubEnv('HIPPO_V1_RPS', undefined);
  vi.stubEnv('HIPPO_CALLER_RPS', undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  bootLimiters(rateLimits);
  return warn.mock.calls.map(([message]) => message);
}

describe('bootLimiters', () => {
  it('warns once when HIPPO_V1_RPS=0 turns the per-address limit off', () => {
    expect(warnsFor({ HIPPO_V1_RPS: '0' })).toEqual(['HIPPO_V1_RPS=0: the per-address rate limit is off']);
  });

  it('warns once when HIPPO_CALLER_RPS=0 turns the per-caller limit off', () => {
    expect(warnsFor({ HIPPO_CALLER_RPS: '0' })).toEqual(['HIPPO_CALLER_RPS=0: the per-caller rate limit is off']);
  });

  it('says nothing with the defaults, or when serve() options switch a limit off', () => {
    expect(warnsFor({})).toEqual([]);
    expect(warnsFor({ HIPPO_V1_RPS: '0' }, { perAddress: 'off', perCaller: 'off' })).toEqual([]);
  });
});
