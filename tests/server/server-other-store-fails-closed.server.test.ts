// Under a store other than hippo.db, a route that needs hippo.db's local files answers 501 and no request opens or creates hippo.db.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb, SqliteBlockedError } from '../../src/db/index.js';
import { STORE_BUSY_MESSAGE } from '../../src/store/port.js';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/util/http-util.js';
import { mcpErrorResponse } from '../../src/mcp/server.js';
import { TOOLS } from '../../src/mcp/tools.js';
import { serve, type ServerHandle } from '../../src/server.js';
import {
  sqliteStore,
  StoreBusyError,
  type ApiKeyRecord,
  type ContinuityKey,
  type HippoStore,
} from '../../src/entry/store-kit.js';
import { V1_ROWS } from '../_helpers/v1-route-rows.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  requestLine,
  localFileRoutes,
  stubStore,
  rpc,
  type TestKey,
  newKey,
  bearer,
} from '../_helpers/other-store-server.js';

describe('serve() under a store that is not hippo.db', () => {
  let root: string;
  let handle: ServerHandle;
  const valid = newKey();
  const busy = newKey();
  const probe = newKey();
  const leaky = newKey();
  const records = new Map([[valid.keyId, valid.record]]);
  const blocked: Error[] = [];
  const lookups = new Map<string, number>();
  // Stands in for a store method that still opens hippo.db, so a store-ready route reaching it must answer 501.
  const unported = async (): Promise<never> => {
    closeHippoDb(openHippoDb(root));
    throw new Error('the stub store does not serve recall');
  };
  let addonRuns = 0;
  const base: Partial<HippoStore> = {
    async findApiKey(keyId: string): Promise<ApiKeyRecord | null> {
      lookups.set(keyId, (lookups.get(keyId) ?? 0) + 1);
      if (keyId === busy.keyId) throw new StoreBusyError();
      if (keyId === probe.keyId) {
        try {
          openHippoDb(root);
        } catch (err) {
          if (err instanceof Error) blocked.push(err);
        }
        return null;
      }
      // Stands in for any unported path: nothing between this open and the reply catches the error.
      if (keyId === leaky.keyId) closeHippoDb(openHippoDb(root));
      return records.get(keyId) ?? null;
    },
    searchRecallEntries: unported,
    entriesByIds: unported,
    activeGoals: unported,
    freshRawEntries: unported,
    continuity: unported,
    planningFallacyEvidence: unported,
    appendAuditEvents: unported,
    finishRecall: unported,
    bumpRecallStats: unported,
    recordTokens: unported,
    async close(): Promise<void> {},
  };
  const post = async (path: string, key: TestKey) =>
    fetch(`${handle.url}${path}`, {
      method: 'POST',
      headers: { ...bearer(key), 'content-type': 'application/json' },
      body: '{}',
    });

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    root = makeRoot('other-store', { init: false });
    handle = await serve({
      hippoRoot: root,
      port: 0,
      store: stubStore(root, base),
      routes: [
        {
          path: '/v1/x-addon',
          handler: async () => {
            addonRuns += 1;
            return {};
          },
        },
        { path: '/v1/x-addon-base', storeReady: 'base', handler: async ({ ctx }) => ({ tenant: ctx.tenantId }) },
        {
          path: '/v1/x-addon-keyaudit',
          storeReady: 'keyAudit',
          handler: async ({ ctx }) => ({ tenant: ctx.tenantId }),
        },
        {
          path: '/v1/x-addon-vectorviews',
          storeReady: 'vectorViews',
          handler: async () => {
            addonRuns += 1;
            return {};
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
  });

  it('answers 501 on the /v1 routes that need local files, and never runs the handler', async () => {
    const routes = localFileRoutes();
    expect(routes).toEqual(['POST /v1/memories/1/promote', 'POST /v1/sleep']);
    for (const route of routes) {
      const res = await post(route.split(' ')[1]!, valid);
      expect({ route, status: res.status, body: await res.json() }).toEqual({
        route,
        status: 501,
        body: { error: STORE_NOT_PORTED_MESSAGE },
      });
    }
  });

  it('runs every other /v1 route, and each refuses the call or answers 501 at the fenced hippo.db', async () => {
    const gated = new Set(localFileRoutes());
    const replies = new Map<string, number>();
    for (const route of V1_ROWS.map(({ key }) => requestLine(key)).filter((line) => !gated.has(line))) {
      const [method, path] = route.split(' ');
      const res = await fetch(`${handle.url}${path}`, {
        method,
        headers: { ...bearer(valid), 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      replies.set(route, res.status);
    }
    expect(replies.size).toBe(V1_ROWS.length - gated.size);
    expect([...replies].filter(([, status]) => ![400, 401, 403, 404, 501].includes(status))).toEqual([]);
  });

  it('answers 501 on an add-on route that names no group, and never runs its handler; a bad key is still a 401', async () => {
    const res = await post('/v1/x-addon', valid);
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 501,
      body: { error: STORE_NOT_PORTED_MESSAGE },
    });
    expect((await post('/v1/x-addon', newKey())).status).toBe(401);
    expect(addonRuns).toBe(0);
  });

  it('runs an add-on route that names a required group, and refuses one whose optional group the store lacks', async () => {
    for (const path of ['/v1/x-addon-base', '/v1/x-addon-keyaudit']) {
      const ran = await post(path, valid);
      expect({ path, status: ran.status, body: await ran.json() }).toEqual({
        path,
        status: 200,
        body: { tenant: valid.record.tenantId },
      });
    }
    expect((await post('/v1/x-addon-base', newKey())).status).toBe(401);
    const refused = await post('/v1/x-addon-vectorviews', valid);
    expect({ status: refused.status, body: await refused.json() }).toEqual({
      status: 501,
      body: { error: STORE_NOT_PORTED_MESSAGE },
    });
    expect(addonRuns).toBe(0);
  });

  it('a bad key on the store-ready /v1/memories and a missing key on /mcp are still a 401', async () => {
    const wrong = await fetch(`${handle.url}/v1/memories?q=deploy`, { headers: bearer(newKey()) });
    expect(wrong.status).toBe(401);
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
    const keyless = await fetch(`${handle.url}/mcp`, { method: 'POST', body: '{}' });
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '');
    expect(keyless.status).toBe(401);
  });

  it('serves the routes that need only auth: /health and /mcp/stream', async () => {
    expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    const ac = new AbortController();
    const stream = await fetch(`${handle.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream', ...bearer(valid) },
      signal: ac.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    ac.abort();
  });

  it('a hippo.db open inside a request throws instead of creating the file', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=deploy`, { headers: bearer(probe) });
    expect(res.status).toBe(401);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toBeInstanceOf(SqliteBlockedError);
    expect(blocked[0]!.message).toMatch(/'stub' store/);
  });

  it('a hippo.db open nothing catches answers 501 store_not_ported on /v1 and on /mcp', async () => {
    for (const [method, path] of [
      ['GET', '/v1/memories?q=deploy'],
      ['POST', '/mcp'],
    ] as const) {
      const res = await fetch(`${handle.url}${path}`, {
        method,
        headers: bearer(leaky),
        body: method === 'GET' ? undefined : '{}',
      });
      expect({ path, status: res.status, body: await res.json() }).toEqual({
        path,
        status: 501,
        body: { error: STORE_NOT_PORTED_MESSAGE },
      });
    }
  });

  it('runs a store-ready route, and its hippo.db open answers 501 store_not_ported', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=deploy`, { headers: bearer(valid) });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 501,
      body: { error: STORE_NOT_PORTED_MESSAGE },
    });
  });

  it('POST /mcp lists every tool but the two that need local files, and a call reaching hippo.db answers store_not_ported', async () => {
    const postMcp = async (body: string): Promise<{ status: number; body: unknown }> => {
      // Another store is shared, and a shared store refuses hippo_recall from a caller that names no project.
      const headers = { ...bearer(valid), 'content-type': 'application/json', 'x-hippo-project': 'p' };
      const res = await fetch(`${handle.url}/mcp`, { method: 'POST', headers, body });
      return { status: res.status, body: await res.json() };
    };
    const list = await postMcp(rpc('tools/list'));
    expect(list.status).toBe(200);
    const listed = TOOLS.map((t) => t.name).filter((name) => name !== 'hippo_share' && name !== 'hippo_peers');
    // SAFETY: a tools/list result carries a tools array of named definitions.
    expect((list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(listed);
    const notPorted = {
      status: 200,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } },
    };
    for (const [name, args] of [
      ['hippo_share', { id: 'mem_x' }],
      ['hippo_status', {}],
      ['hippo_recall', { query: 'deploy' }],
    ] as const) {
      expect({ name, ...(await postMcp(rpc('tools/call', { name, arguments: args }))) }).toEqual({
        name,
        ...notPorted,
      });
    }
  });

  it('a SqliteBlockedError inside an MCP tool call answers store_not_ported, not an internal error', () => {
    expect(mcpErrorResponse(7, new SqliteBlockedError('stub'))).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE },
    });
  });

  it('a StoreBusyError from the store is a 503 with Retry-After on /v1 and on /mcp', async () => {
    for (const [method, path] of [
      ['GET', '/v1/memories?q=deploy'],
      ['POST', '/mcp'],
    ] as const) {
      const res = await fetch(`${handle.url}${path}`, {
        method,
        headers: bearer(busy),
        body: method === 'GET' ? undefined : '{}',
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(await res.json()).toEqual({ error: STORE_BUSY_MESSAGE });
    }
  });

  it("asks the store for a key's row on every request, so a revoke written to that store is a 401 on the next one", async () => {
    const key = newKey();
    records.set(key.keyId, key.record);
    const statusOf = async (): Promise<number> => (await post('/v1/sleep', key)).status;
    expect([await statusOf(), await statusOf()]).toEqual([501, 501]);
    expect(lookups.get(key.keyId)).toBe(2);
    records.set(key.keyId, { ...key.record, revokedAt: new Date().toISOString() });
    expect(await statusOf()).toBe(401);
  });

  it('leaves nothing under the served root but the pidfile: no hippo.db, no .hippo folder', () => {
    expect(readdirSync(root)).toEqual(['server.pid']);
    expect(existsSync(join(root, '.hippo'))).toBe(false);
  });
});

describe('serve() under another store reads its folder as shared, though no config.json says so', () => {
  let root: string;
  let handle: ServerHandle;
  const alice = newKey();
  const keys: (ContinuityKey | null)[] = [];
  const snapshot = {
    id: 1,
    task: 'ship the eu cluster',
    summary: 'cutover planned',
    next_step: 'run the canary',
    status: 'active',
    source: 'cli',
    session_id: 's1',
    scope: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  const notRead = async (): Promise<never> => {
    throw new Error('this recall reads nothing else');
  };
  const base: Partial<HippoStore> = {
    findApiKey: async (keyId) => (keyId === alice.keyId ? { ...alice.record, ownerSubject: 'alice' } : null),
    searchRecallEntries: async () => [],
    entriesByIds: notRead,
    activeGoals: notRead,
    freshRawEntries: notRead,
    // As continuityWhere: null reads the tenant's newest, and a key missing its owner or project matches nothing.
    continuity: async (_tenantId, _eventLimit, key) => {
      keys.push(key);
      const matches = key === null || (key.owner !== '' && key.project.length > 0);
      return { activeSnapshot: matches ? snapshot : null, sessionHandoff: null, recentSessionEvents: [] };
    },
    planningFallacyEvidence: notRead,
    appendAuditEvents: async () => {},
    finishRecall: async () => {},
    bumpRecallStats: async () => {},
    recordTokens: async () => {},
    async close(): Promise<void> {},
  };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    root = makeRoot('other-store-shared', { init: false });
    handle = await serve({ hippoRoot: root, port: 0, store: stubStore(root, base) });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
  });

  it("keys an MCP recall's continuity to the caller's owner and project", async () => {
    const headers = { ...bearer(alice), 'content-type': 'application/json', 'x-hippo-project': 'p' };
    const body = rpc('tools/call', { name: 'hippo_recall', arguments: { query: 'deploy', include_continuity: true } });
    const res = await fetch(`${handle.url}/mcp`, { method: 'POST', headers, body });
    expect(JSON.stringify(await res.json())).toContain('ship the eu cluster');
    expect(keys.at(-1)).toEqual({ owner: 'alice', project: ['p'] });
  });

  it('hands a REST recall, which names no project, a key that matches nothing, so its block is empty', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=deploy&include_continuity=true`, { headers: bearer(alice) });
    expect(res.status).toBe(200);
    expect(keys.at(-1)).toEqual({ owner: 'alice', project: [] });
    expect(await res.json()).toMatchObject({
      continuity: { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] },
    });
  });
});

describe('a StoreBusyError on the hippo.db path', () => {
  let root: string;
  let handle: ServerHandle;

  beforeAll(async () => {
    root = makeRoot('store-busy');
    const busyKeys: HippoStore = {
      ...sqliteStore(root),
      findApiKey: async () => {
        throw new StoreBusyError();
      },
    };
    handle = await serve({ hippoRoot: root, port: 0, store: busyKeys });
  });

  afterAll(async () => {
    await handle.stop();
  });

  it('is a 503 with Retry-After on a /v1 route and on POST /mcp', async () => {
    const headers = { authorization: `Bearer ${newKey().plaintext}`, 'content-type': 'application/json' };
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const [method, path, body] of [
      ['GET', '/v1/memories?q=x', undefined],
      ['POST', '/mcp', rpc],
    ] as const) {
      const res = await fetch(`${handle.url}${path}`, { method, headers, body });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(await res.json()).toEqual({ error: STORE_BUSY_MESSAGE });
    }
  });

  it('a StoreBusyError thrown inside an MCP tool call answers with the busy message, not an internal error', () => {
    expect(mcpErrorResponse(7, new StoreBusyError())).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: STORE_BUSY_MESSAGE },
    });
  });
});
