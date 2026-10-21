// One salience gate in api.remember: a direct, a routed and a REST write of the same text are judged the same way.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { adminActor, remember, rememberLocally } from '../../src/api/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { serve, type ServerHandle } from '../../src/server.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

const TEXT = 'the billing service retries a failed charge three times';
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function store(salience: boolean): FullContext {
  const hippoRoot = makeRoot('remember-gate', {
    config: { embeddings: { enabled: false }, salience: { enabled: salience } },
  });
  roots.push(hippoRoot);
  return apiCtx(hippoRoot, 'default', adminActor('cli'));
}
const rowCount = (ctx: FullContext): number => loadAllEntries(ctx.hippoRoot, ctx.tenantId).length;

describe('api.remember with salienceGate', () => {
  it('skips a repeat of the same text with the reason a direct write gives', async () => {
    const ctx = store(true);
    await remember(ctx, { content: TEXT, tags: [], salienceGate: true });
    const routed = await remember(ctx, { content: TEXT, tags: [], salienceGate: true });
    const direct = await rememberLocally(ctx, { content: TEXT, tags: [] });
    expect(direct.status).toBe('skipped');
    expect(routed).toEqual({ skipped: { reason: expect.stringContaining('duplicate'), score: 0.1 } });
    if (direct.status === 'skipped') {
      expect(routed).toEqual({ skipped: { reason: direct.reason, score: direct.score } });
    }
    expect(rowCount(ctx)).toBe(1);
  });

  it('stores the repeat when the field is absent or the store has the gate off', async () => {
    const on = store(true);
    await remember(on, { content: TEXT });
    expect('id' in (await remember(on, { content: TEXT }))).toBe(true);
    const off = store(false);
    await remember(off, { content: TEXT, salienceGate: true });
    expect('id' in (await remember(off, { content: TEXT, salienceGate: true }))).toBe(true);
    expect([rowCount(on), rowCount(off)]).toEqual([2, 2]);
  });
});

describe('POST /v1/memories gate and force', () => {
  let ctx: FullContext;
  let handle: ServerHandle;
  let key: string;

  beforeEach(async () => {
    ctx = store(true);
    const db = openHippoDb(ctx.hippoRoot);
    try {
      key = createApiKey(db, { tenantId: 'default', role: 'member', ownerSubject: 'oid-a' }).plaintext;
    } finally {
      closeHippoDb(db);
    }
    handle = await serve({ hippoRoot: ctx.hippoRoot, port: 0 });
  });
  afterEach(async () => {
    await handle.stop();
  });

  const call = (method: string, path: string, body?: Record<string, JsonValue>): Promise<Response> =>
    fetch(`${handle.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: body && JSON.stringify(body),
    });

  it('skips a repeat, and stores it when force is true', async () => {
    expect((await call('POST', '/v1/memories', { content: TEXT })).status).toBe(200);
    const skipped = await call('POST', '/v1/memories', { content: TEXT });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ skipped: { score: 0.1 } });
    expect(rowCount(ctx)).toBe(1);
    const forced = await call('POST', '/v1/memories', { content: TEXT, force: true });
    expect(await forced.json()).toMatchObject({ kind: 'distilled' });
    expect(rowCount(ctx)).toBe(2);
  });

  it('skips a short low-salience text unless force is true', async () => {
    expect(await (await call('POST', '/v1/memories', { content: 'yes' })).json()).toHaveProperty('skipped');
    expect(rowCount(ctx)).toBe(0);
    expect(await (await call('POST', '/v1/memories', { content: 'yes', force: true })).json()).toHaveProperty('id');
    expect(rowCount(ctx)).toBe(1);
  });

  it('refuses a force that is not a boolean', async () => {
    const res = await call('POST', '/v1/memories', { content: TEXT, force: 'yes' });
    expect([res.status, await res.json()]).toEqual([400, { error: 'force must be a boolean' }]);
  });

  it('names the allowed kinds for a bad kind and does not echo the value', async () => {
    const res = await call('POST', '/v1/memories', { content: TEXT, kind: 'zzz-unique' });
    // SAFETY: the route answers every 400 with an `{ error: string }` body.
    const { error } = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(error).toContain('allowed: ');
    expect(error).not.toContain('zzz-unique');
  });

  it.each([
    ['/v1/sessions/s1/assemble?budget=0', 'budget must be a positive number'],
    ['/v1/sessions/s1/assemble?budget=abc', 'budget must be a positive number'],
    ['/v1/sessions/s1/assemble?freshTail=-1', 'freshTail must be a non-negative number'],
    ['/v1/recall/drill/s1?limit=0', 'limit must be a positive number'],
    ['/v1/recall/drill/s1?budget=-5', 'budget must be a positive number'],
    ['/v1/recall/drill/s1?depth=11', 'depth must be a positive integer between 1 and 10'],
    ['/v1/recall/drill/s1?depth=1.5', 'depth must be a positive integer between 1 and 10'],
  ])('%s answers 400 %s', async (path, message) => {
    const res = await call('GET', path);
    expect([res.status, await res.json()]).toEqual([400, { error: message }]);
  });
});
