// A resolver is plugin code, so its scopes are bounded like the tenant and subject beside them.
import { afterEach, expect, it } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
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
