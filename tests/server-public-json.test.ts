// serve({ publicJson }): fixed JSON at plain GET /v1 paths, sent to anyone with no auth, body read or store access.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '../src/json.js';
import { initStore } from '../src/store/open.js';
import { serve, type ApiKeyRecord, type HippoStore, type ServerHandle } from '../src/server.js';

const INFO = '/v1/x-info';
const BODY = { providers: [{ tenant: 't1', scopes: ['api://x/.default'], redirectUris: ['http://localhost/cb'] }] };
const WELL_FORMED_KEY = `hk_${'a'.repeat(24)}.${'b'.repeat(32)}`;

let root: string;
let handle: ServerHandle | null = null;

beforeEach(() => {
  vi.stubEnv('HIPPO_V1_RPS', '0');
  vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
  root = mkdtempSync(join(tmpdir(), 'hippo-public-json-'));
  initStore(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  body: string;
}

const served: Reply = { status: 200, contentType: 'application/json', cacheControl: 'no-store', body: JSON.stringify(BODY) };

async function start(publicJson: Readonly<Record<string, JsonValue>>, hippoRoot = root, store?: HippoStore): Promise<void> {
  handle = await serve({ hippoRoot, host: '127.0.0.1', port: 0, publicJson, store });
}

async function send(method: string, path: string, authorization?: string): Promise<Reply> {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  const res = await fetch(`${handle!.url}${path}`, { method, headers });
  return { status: res.status, contentType: res.headers.get('content-type'), cacheControl: res.headers.get('cache-control'), body: await res.text() };
}

/** The error serve() throws for this publicJson, or null when it started; a started server is stopped so a case never leaks one. */
async function bootError(publicJson: Readonly<Record<string, JsonValue>>): Promise<Error | null> {
  return serve({ hippoRoot: root, host: '127.0.0.1', port: 0, publicJson }).then(
    async (h) => { await h.stop(); return null; },
    (err: Error) => err,
  );
}

describe('a publicJson path behind serve()', () => {
  it('sends the body as uncached 200 JSON with no key, a bad API key or a token no resolver vouches for', async () => {
    await start({ [INFO]: BODY });
    expect(await send('GET', INFO)).toEqual(served);
    expect(await send('GET', INFO, 'Bearer hk_invalid.deadbeef')).toEqual(served);
    expect(await send('GET', INFO, `Bearer ${WELL_FORMED_KEY}`)).toEqual(served);
    expect(await send('GET', INFO, 'Bearer not-an-api-key')).toEqual(served);
  });

  it('answers every other call as a server without it does: unconfigured paths, and POST, HEAD and PUT on the public path', async () => {
    const calls = [['GET', '/v1/x-other'], ['GET', '/v1/memories?q=x'], ['POST', INFO], ['HEAD', INFO], ['PUT', INFO]] as const;
    const replies = async (): Promise<Reply[]> => {
      const out: Reply[] = [];
      for (const [method, path] of calls) out.push(await send(method, path));
      return out;
    };
    await start({});
    const before = await replies();
    await handle!.stop();
    await start({ [INFO]: BODY });
    expect(await replies()).toEqual(before);
    expect(before.map((r) => r.status)).toEqual([404, 401, 404, 404, 404]);
  });

  it('keeps the text it built at boot when the caller changes the object afterwards', async () => {
    const value = { v: 1 };
    const publicJson = Object.fromEntries([[INFO, value]]);
    await start(publicJson);
    value.v = 2;
    publicJson['/v1/x-late'] = { v: 3 };
    expect((await send('GET', INFO)).body).toBe('{"v":1}');
    expect((await send('GET', '/v1/x-late')).status).toBe(404);
  });

  it('may take a path core serves only on POST, and the POST still reaches core', async () => {
    await start({ '/v1/outcome': BODY });
    expect(await send('GET', '/v1/outcome')).toEqual(served);
    expect((await send('POST', '/v1/outcome')).status).toBe(401);
  });

  it('is counted by the rate limiter like any /v1 path', async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0.5');
    await start({ [INFO]: BODY });
    expect(await send('GET', INFO)).toEqual(served);
    expect(await send('GET', INFO)).toMatchObject({ status: 429, body: '{"error":"rate limit exceeded"}' });
  });
});

describe('a publicJson path under a store that is not hippo.db', () => {
  it('is served without asking the store, and leaves no hippo.db behind', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'hippo-public-json-stub-'));
    let lookups = 0;
    const store: HippoStore = {
      kind: 'stub',
      async findApiKey(): Promise<ApiKeyRecord | null> { lookups += 1; return null; },
      async close(): Promise<void> {},
    };
    try {
      await start({ [INFO]: BODY }, bare, store);
      expect(await send('GET', INFO, `Bearer ${WELL_FORMED_KEY}`)).toEqual(served);
      expect(lookups).toBe(0);
      // The same key on a core route does reach the store, so the zero above is the public path skipping it.
      expect((await send('GET', '/v1/memories', `Bearer ${WELL_FORMED_KEY}`)).status).toBe(401);
      expect(lookups).toBe(1);
      expect(readdirSync(bare)).toEqual(['server.pid']);
    } finally {
      await handle?.stop();
      handle = null;
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('serve() refuses a publicJson path it cannot serve safely', () => {
  it.each([
    ['no /v1/ prefix', '/x-info'],
    ['the bare /v1', '/v1'],
    ['a dot segment', '/v1/./x'],
    ['a space', '/v1/a b'],
    ['a route parameter', '/v1/:id'],
    ['a trailing slash', '/v1/x/'],
    ['a query string', '/v1/x?y=1'],
  ])('%s: %s', async (_name, path) => {
    expect((await bootError({ [path]: {} }))?.message).toBe(`public JSON path '${path}' is not a plain /v1/ path (segments use A-Z a-z 0-9 . _ ~ -)`);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it.each([
    ['an exact core GET row', '/v1/memories'],
    ['another exact core GET row', '/v1/auth/keys'],
    ['a pattern core GET row', '/v1/sessions/x/assemble'],
    ['a regex core GET row', '/v1/predictions/7'],
  ])('%s: %s', async (_name, path) => {
    expect((await bootError({ [path]: {} }))?.message).toBe(`public JSON path '${path}' is already served by core`);
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('a body over 64 KiB once serialized, counted in UTF-8 bytes', async () => {
    expect(await bootError({ [INFO]: 'a'.repeat(64 * 1024 - 2) })).toBeNull();
    for (const over of ['a'.repeat(64 * 1024 - 1), 'é'.repeat(32 * 1024)]) {
      expect((await bootError({ [INFO]: over }))?.message).toBe(`public JSON at '${INFO}' is over 64 KiB`);
    }
    expect(existsSync(join(root, 'server.pid'))).toBe(false);
  });

  it('a value JSON.stringify writes nothing for', async () => {
    const bad: unknown[] = [undefined, () => 1];
    for (const value of bad) {
      // SAFETY: both values break the JsonValue contract on purpose, the way an untyped caller could.
      expect((await bootError({ [INFO]: value as JsonValue }))?.message).toBe(`public JSON at '${INFO}' is not JSON`);
    }
  });
});
