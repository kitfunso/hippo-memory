// serve({ routes }): an add-on mounts POST /v1 routes behind core's auth and JSON parsing, and cannot shadow a core route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiKey } from '../src/auth.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import type { JsonValue } from '../src/json.js';
import { initStore } from '../src/store/open.js';
import { HttpError, serve, type AddonCall, type AddonRoute, type ServerHandle } from '../src/server.js';

const ECHO = '/v1/x-echo';

let root: string;
let handle: ServerHandle | null = null;
let apiKey = '';
let calls: AddonCall[] = [];

beforeEach(() => {
  vi.stubEnv('HIPPO_V1_RPS', '0');
  vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
  root = mkdtempSync(join(tmpdir(), 'hippo-addon-routes-'));
  initStore(root);
  const db = openHippoDb(root);
  try {
    apiKey = createApiKey(db, { tenantId: 'tenant-x', label: 'addon-test' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  calls = [];
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** An add-on route that records every call it gets and answers with `reply`. */
function route(path: string, reply: () => Promise<JsonValue>): AddonRoute {
  return { path, handler: async (call) => { calls.push(call); return reply(); } };
}

const echo = (): AddonRoute => route(ECHO, async () => ({ ok: true }));

async function start(routes: readonly AddonRoute[]): Promise<void> {
  handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0, routes });
}

/** The error serve() throws for these routes, or null when it started; a started server is stopped so a case never leaks one. */
async function bootError(routes: readonly AddonRoute[]): Promise<Error | null> {
  return serve({ hippoRoot: root, host: '127.0.0.1', port: 0, routes }).then(
    async (h) => { await h.stop(); return null; },
    (err: Error) => err,
  );
}

async function post(path: string, body: string, key: string | null = apiKey): Promise<{ status: number; reply: unknown }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== null) headers.set('authorization', `Bearer ${key}`);
  const res = await fetch(`${handle!.url}${path}`, { method: 'POST', headers, body });
  return { status: res.status, reply: await res.json() };
}

describe('an add-on route behind serve()', () => {
  it('hands the handler the key tenant and the parsed body, and sends its value back as 200 JSON', async () => {
    await start([route(ECHO, async () => ({ seen: calls.length, nested: { list: [1, 'two', null] } }))]);
    const res = await post(ECHO, JSON.stringify({ a: 1, b: { c: 'd' } }));
    expect(res).toEqual({ status: 200, reply: { seen: 1, nested: { list: [1, 'two', null] } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx.tenantId).toBe('tenant-x');
    expect(calls[0]!.ctx.hippoRoot).toBe(root);
    expect(calls[0]!.body).toEqual({ a: 1, b: { c: 'd' } });
  });

  it('answers 401 and never runs the handler for no key or a bad key', async () => {
    await start([echo()]);
    expect((await post(ECHO, '{}', null)).status).toBe(401);
    expect((await post(ECHO, '{}', 'hk_invalid.deadbeef')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 400 and never runs the handler for a body that is not a JSON object', async () => {
    await start([echo()]);
    for (const body of ['{not json', '[1,2]', '"text"']) expect((await post(ECHO, body)).status, body).toBe(400);
    expect(calls).toEqual([]);
  });

  it('maps an HttpError from the handler to its status with an {error} body', async () => {
    await start([route(ECHO, async () => { throw new HttpError(404, 'no such thing'); })]);
    expect(await post(ECHO, '{}')).toEqual({ status: 404, reply: { error: 'no such thing' } });
  });

  it('serves POST only: a GET on the add-on path is core\'s 404', async () => {
    await start([echo()]);
    const res = await fetch(`${handle!.url}${ECHO}`, { headers: { authorization: `Bearer ${apiKey}` } });
    expect({ status: res.status, reply: await res.json() }).toEqual({ status: 404, reply: { error: 'not found' } });
    expect(calls).toEqual([]);
  });
});

describe('serve() refuses an add-on route that could shadow or dodge core', () => {
  it.each([
    ['an exact core row', '/v1/memories'],
    ['another exact core row', '/v1/auth/keys'],
    ['a pattern core row', '/v1/memories/x/archive'],
    ['a regex core row', '/v1/predictions/7/close'],
    ['a public connector route', '/v1/connectors/slack/events'],
  ])('%s: %s', async (_name, path) => {
    const err = await bootError([route(path, async () => ({}))]);
    expect(err?.message).toMatch(/already served by core/);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it.each([
    ['no /v1/ prefix', '/x-echo'],
    ['the bare /v1', '/v1'],
    ['a dot segment', '/v1/./x'],
    ['a space', '/v1/a b'],
    ['a route parameter', '/v1/:id'],
    ['a trailing slash', '/v1/x/'],
    ['a query string', '/v1/x?y=1'],
  ])('%s: %s', async (_name, path) => {
    const err = await bootError([route(path, async () => ({}))]);
    expect(err?.message).toMatch(/not a plain \/v1\/ path/);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('a duplicate path', async () => {
    const err = await bootError([echo(), echo()]);
    expect(err?.message).toMatch(/registered twice/);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('accepts a near-miss of a regex core row, and routes it to the add-on handler', async () => {
    const near = '/v1/predictions/abc/close';
    await start([route(near, async () => ({ near: true }))]);
    expect(await post(near, '{}')).toEqual({ status: 200, reply: { near: true } });
    expect(calls).toHaveLength(1);
    // The real row is untouched: a numeric id still reaches core's handler, never the add-on's.
    expect((await post('/v1/predictions/7/close', '{"state":"closed"}')).reply).not.toEqual({ near: true });
    expect(calls).toHaveLength(1);
  });
});
