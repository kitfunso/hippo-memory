// A resolver is plugin code, so its scopes are bounded like the tenant and subject beside them.
import { afterEach, expect, it } from 'vitest';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { MAX_ID_LEN } from '../../src/base/util/limits.js';
import { makeRoot } from '../_helpers/make-root.js';

let handle: ServerHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

async function statusWithScopes(scopes: readonly string[]): Promise<number> {
  handle = await serve({
    hippoRoot: makeRoot('resolver-scope-cap'),
    host: '127.0.0.1',
    port: 0,
    authResolver: () => ({ tenantId: 'default', subject: 'user-1', role: 'member', scopes }),
  });
  const res = await fetch(`${handle.url}/v1/memories?q=x`, { headers: { authorization: 'Bearer ext.token' } });
  await res.body?.cancel();
  return res.status;
}

const scope = (i: number, length = 32): string => `team:${i}:`.padEnd(length, 'x');

it('accepts 1024 scopes of the longest allowed length', async () => {
  expect(await statusWithScopes(Array.from({ length: 1024 }, (_, i) => scope(i, MAX_ID_LEN)))).toBe(200);
});

it('refuses 1025 scopes', async () => {
  expect(await statusWithScopes(Array.from({ length: 1025 }, (_, i) => scope(i)))).toBe(401);
});

it('refuses a scope one character past the id cap', async () => {
  expect(await statusWithScopes([scope(0), scope(1, MAX_ID_LEN + 1)])).toBe(401);
});

const GUESSES = 6;

async function statusesOfWrongTokens(count: number): Promise<number[]> {
  handle = await serve({
    hippoRoot: makeRoot('resolver-failed-auth'),
    host: '127.0.0.1',
    port: 0,
    rateLimits: { perAddress: 'off', failedAuthPerAddress: { ratePerSec: 0.001, burst: GUESSES - 1 } },
    authResolver: () => null,
  });
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${handle.url}/v1/memories?q=x`, { headers: { authorization: `Bearer wrong.${i}` } });
    await res.body?.cancel();
    statuses.push(res.status);
  }
  return statuses;
}

it('answers 429 to wrong resolver tokens once the address spent its failed-auth budget, as it does for wrong keys', async () => {
  expect(await statusesOfWrongTokens(GUESSES)).toEqual([401, 401, 401, 401, 401, 429]);
});

it('aborts the signal it hands the resolver when the deadline passes, and answers 503', async () => {
  let signal: AbortSignal | undefined;
  handle = await serve({
    hippoRoot: makeRoot('resolver-abort'),
    host: '127.0.0.1',
    port: 0,
    authResolverTimeoutMs: 50,
    authResolver: (_token, s) => {
      signal = s;
      return new Promise(() => undefined);
    },
  });
  const res = await fetch(`${handle.url}/v1/memories?q=x`, { headers: { authorization: 'Bearer ext.token' } });
  await res.body?.cancel();
  expect([res.status, signal?.aborted]).toEqual([503, true]);
});

async function statusForSubject(subject: string): Promise<number> {
  handle = await serve({
    hippoRoot: makeRoot('resolver-subject'),
    host: '127.0.0.1',
    port: 0,
    authResolver: () => ({ tenantId: 'default', subject, role: 'member' }),
  });
  const res = await fetch(`${handle.url}/v1/memories?q=x`, { headers: { authorization: 'Bearer ext.token' } });
  await res.body?.cancel();
  await handle.stop();
  handle = undefined;
  return res.status;
}

it.each(['system\u200b', '\u202esystem', 'sys\u2028tem', 'a\u2029b', 'sys\u00adtem'])(
  'refuses a subject hiding a format or separator character (%j)',
  async (subject) => {
    expect(await statusForSubject(subject)).toBe(401);
  },
);

it('still takes a plain non-ASCII subject', async () => {
  expect(await statusForSubject('zoë@例え.example')).toBe(200);
});
