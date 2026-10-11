// Under a store other than hippo.db, a route not yet ported to it answers 501 and no request opens or creates hippo.db.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb, SqliteBlockedError } from '../src/db/index.js';
import { STORE_BUSY_MESSAGE } from '../src/store/port.js';
import { rethrowIfSqliteBlocked, StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { mapApiError, STORE_NOT_PORTED_MESSAGE } from '../src/util/http-util.js';
import { mcpErrorResponse, type McpRequest } from '../src/mcp/server.js';
import { initStore } from '../src/store/open.js';
import { serve, sqliteStore, StoreBusyError, type ApiKeyRecord, type ContinuityKey, type HippoStore, type ServerHandle } from '../src/server.js';
import { physicsSearch } from '../src/search/physics-search.js';
import { requireVectorReads } from '../src/search/vector.js';
import { loadEntriesByIds } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { V1_ROWS } from './_helpers/v1-route-rows.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { inMemoryGraphReadsStore, seedGraphRows, type SeededGraph } from './_helpers/in-memory-graph-reads-store.js';
import { inMemoryObjectsStore, type InMemoryObjectsStore } from './_helpers/in-memory-objects-store.js';
import { inMemoryPredictionsStore, type InMemoryPredictionsStore } from './_helpers/in-memory-predictions-store.js';
import { HELD, heldAt, heldContent, inMemoryQuarantineStore, seedQuarantineRecords, type InMemoryQuarantineStore } from './_helpers/in-memory-quarantine-store.js';
import { portOnlyStoreWithoutVectorReads } from './_helpers/port-only-store.js';
import { seeded } from './_helpers/recall-golden-seed.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from './_helpers/store-conformance.js';


/** Every V1_ROUTES entry as 'METHOD /path' beside the group it names, each :param slot filled with 1. */
function v1Routes(): { route: string; group: string | undefined }[] {
  return V1_ROWS.map(({ key, route }) => ({ route: key.replace(/:\w+/g, '1'), group: route.storeReady }));
}

/** The entries the stub store cannot run: no group named, or one besides 'base'. */
function unportedV1Routes(): string[] {
  return v1Routes().filter((r) => r.group !== 'base').map((r) => r.route);
}

const rpc = (method: string, params?: McpRequest['params']): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const base32 = (n: number): string => Array.from(randomBytes(n), (b) => BASE32[b % 32]).join('');

interface TestKey {
  keyId: string;
  plaintext: string;
  record: ApiKeyRecord;
}

function newKey(): TestKey {
  const keyId = `hk_${base32(24)}`;
  const plaintext = `${keyId}.${base32(32)}`;
  const salt = randomBytes(16);
  const keyHash = `scrypt$${salt.toString('hex')}$${scryptSync(plaintext, salt, 32).toString('hex')}`;
  return { keyId, plaintext, record: { keyHash, tenantId: 'default', revokedAt: null, role: 'member', scopes: [], expiresAt: null } };
}

const bearer = (key: TestKey) => ({ authorization: `Bearer ${key.plaintext}` });

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
  const store: HippoStore = {
    kind: 'stub',
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

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    root = mkdtempSync(join(tmpdir(), 'hippo-other-store-'));
    handle = await serve({
      hippoRoot: root, port: 0, store, routes: [
        { path: '/v1/x-addon', handler: async () => { addonRuns += 1; return {}; } },
        { path: '/v1/x-addon-base', storeReady: 'base', handler: async ({ ctx }) => ({ tenant: ctx.tenantId }) },
        { path: '/v1/x-addon-keyaudit', storeReady: 'keyAudit', handler: async () => { addonRuns += 1; return {}; } },
      ],
    });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers 501 on every unported /v1 route and both connectors, and never runs the handler', async () => {
    const routes = [...unportedV1Routes(), 'POST /v1/connectors/slack/events', 'POST /v1/connectors/github/events'];
    expect(routes).toHaveLength(63);
    for (const route of routes) {
      const [method, path] = route.split(' ');
      const res = await fetch(`${handle.url}${path}`, {
        method,
        headers: { ...bearer(valid), 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      expect({ route, status: res.status, body: await res.json() }).toEqual({
        route,
        status: 501,
        body: { error: STORE_NOT_PORTED_MESSAGE },
      });
    }
  });

  it('answers 501 on an add-on route and never runs its handler; a bad key is still a 401', async () => {
    const send = async (key: TestKey) => fetch(`${handle.url}/v1/x-addon`, { method: 'POST', headers: { ...bearer(key), 'content-type': 'application/json' }, body: '{}' });
    const res = await send(valid);
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
    expect((await send(newKey())).status).toBe(401);
    expect(addonRuns).toBe(0);
  });

  it('runs an add-on route whose group the store has, and refuses one whose group it lacks', async () => {
    const post = async (path: string, key: TestKey) => fetch(`${handle.url}${path}`, { method: 'POST', headers: { ...bearer(key), 'content-type': 'application/json' }, body: '{}' });
    const ran = await post('/v1/x-addon-base', valid);
    expect({ status: ran.status, body: await ran.json() }).toEqual({ status: 200, body: { tenant: valid.record.tenantId } });
    expect((await post('/v1/x-addon-base', newKey())).status).toBe(401);
    const refused = await post('/v1/x-addon-keyaudit', valid);
    expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
    expect(addonRuns).toBe(0);
  });

  it('a bad key on the store-ready /v1/memories and a missing key on /mcp are still a 401', async () => {
    // /v1/memories parses its query before it checks the key, so q keeps a parse error from answering first.
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
    for (const [method, path] of [['GET', '/v1/memories?q=deploy'], ['POST', '/mcp']] as const) {
      const res = await fetch(`${handle.url}${path}`, { method, headers: bearer(leaky), body: method === 'GET' ? undefined : '{}' });
      expect({ path, status: res.status, body: await res.json() }).toEqual({ path, status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
    }
  });

  it('runs a store-ready route, and its hippo.db open answers 501 store_not_ported', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=deploy`, { headers: bearer(valid) });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
  });

  it('POST /mcp lists only the store-ready tools and refuses the rest with store_not_ported', async () => {
    const post = async (body: string): Promise<{ status: number; body: unknown }> => {
      // Another store is shared, and a shared store refuses hippo_recall from a caller that names no project.
      const headers = { ...bearer(valid), 'content-type': 'application/json', 'x-hippo-project': 'p' };
      const res = await fetch(`${handle.url}/mcp`, { method: 'POST', headers, body });
      return { status: res.status, body: await res.json() };
    };
    const list = await post(rpc('tools/list'));
    expect(list.status).toBe(200);
    // SAFETY: a tools/list result carries a tools array of named definitions.
    expect((list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(['hippo_recall']);
    expect(await post(rpc('tools/call', { name: 'hippo_status', arguments: {} }))).toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } },
    });
    expect(await post(rpc('tools/call', { name: 'hippo_recall', arguments: { query: 'deploy' } }))).toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } },
    });
  });

  it('a SqliteBlockedError inside an MCP tool call answers store_not_ported, not an internal error', () => {
    expect(mcpErrorResponse(7, new SqliteBlockedError('stub'))).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } });
  });

  it('a StoreBusyError from the store is a 503 with Retry-After on /v1 and on /mcp', async () => {
    for (const [method, path] of [['GET', '/v1/memories?q=deploy'], ['POST', '/mcp']] as const) {
      const res = await fetch(`${handle.url}${path}`, { method, headers: bearer(busy), body: method === 'GET' ? undefined : '{}' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(await res.json()).toEqual({ error: STORE_BUSY_MESSAGE });
    }
  });

  it("asks the store for a key's row on every request, so a revoke written to that store is a 401 on the next one", async () => {
    const key = newKey();
    records.set(key.keyId, key.record);
    const statusOf = async (): Promise<number> => (await fetch(`${handle.url}/v1/audit`, { headers: bearer(key) })).status;
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

describe('serve() under a store that has the predictions group', () => {
  let fixture: TwoTenantFixture;
  let memory: InMemoryPredictionsStore;
  let handle: ServerHandle;

  const hippoDbRows = () => {
    const db = openHippoDb(fixture.dir);
    try {
      // SAFETY: each SELECT names the one column n.
      const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return { predictions: count('predictions'), memories: count('memories'), audit: count('audit_log') };
    } finally {
      closeHippoDb(db);
    }
  };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    fixture = seedTwoTenants();
    memory = inMemoryPredictionsStore(fixture.dir);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: memory.store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('runs the five predictions routes on that store, inside the caller\'s tenant, and writes nothing to hippo.db', async () => {
    const before = hippoDbRows();
    const call = async (token: string, method: string, path: string, body?: string): Promise<{ status: number; body: unknown }> => {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const res = await fetch(`${handle.url}${path}`, { method, headers, body });
      return { status: res.status, body: await res.json() };
    };
    const { memberA, memberB } = fixture.tokens;
    expect(await call(memberA, 'POST', '/v1/predictions', '{"claim":"the cutover takes two days","classTag":"cutover","estimate":2}')).toMatchObject({
      status: 201, body: { prediction: { id: 1, tenantId: TENANT_A, classTag: 'cutover', estimateValue: 2, closureState: 'open' } },
    });
    expect(await call(memberA, 'GET', '/v1/predictions?status=open')).toMatchObject({ status: 200, body: { predictions: [{ id: 1 }], next_cursor: null } });
    expect(await call(memberA, 'GET', '/v1/predictions/1')).toMatchObject({ status: 200, body: { prediction: { id: 1, claimText: 'the cutover takes two days' } } });
    expect(await call(memberA, 'POST', '/v1/predictions/1/close', '{"state":"closed","actual":3}')).toMatchObject({
      status: 200, body: { prediction: { id: 1, closureState: 'closed', actualValue: 3 } },
    });
    expect(await call(memberA, 'GET', '/v1/predictions/stats?class=cutover')).toMatchObject({ status: 200, body: { baserate: { nClosed: 1, meanRatio: 1.5 } } });
    expect(await call(memberB, 'GET', '/v1/predictions')).toEqual({ status: 200, body: { predictions: [], next_cursor: null } });
    expect((await call(memberB, 'GET', '/v1/predictions/1')).status).toBe(404);
    expect((await call(memberB, 'POST', '/v1/predictions/1/close', '{"state":"closed","actual":3}')).status).toBe(404);
    const actor = `api_key:${fixture.keys.memberA}`;
    expect(memory.auditRows().slice(-4).map((e) => [e.op, e.actor, e.tenantId])).toEqual([
      ['predict_create', actor, TENANT_A], ['remember', actor, TENANT_A], ['predict_close', actor, TENANT_A], ['predict_baserate', actor, TENANT_A],
    ]);
    expect(hippoDbRows()).toEqual(before);
  });
});

describe('serve() under a store that has the quarantine group', () => {
  let fixture: TwoTenantFixture;
  let memory: InMemoryQuarantineStore;
  let handle: ServerHandle;
  let adminB: string;

  const hippoDbRows = () => {
    const db = openHippoDb(fixture.dir);
    try {
      // SAFETY: each SELECT names exactly the columns of the type it is read as.
      const records = db.prepare('SELECT tenant_id, memory_id, status, decided_at FROM memory_quarantine ORDER BY tenant_id, memory_id').all() as object[];
      // SAFETY: as above.
      const scopes = db.prepare('SELECT id, scope FROM memories ORDER BY id').all() as object[];
      // SAFETY: the SELECT names the one column n.
      return { records, scopes, audit: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n };
    } finally {
      closeHippoDb(db);
    }
  };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    fixture = seedTwoTenants();
    adminB = seedQuarantineRecords(fixture.dir);
    memory = inMemoryQuarantineStore(fixture.dir);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: memory.store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("runs the three quarantine routes on that store, inside the caller's tenant, and writes nothing to hippo.db", async () => {
    const before = hippoDbRows();
    const call = async (token: string, method: string, path: string): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${handle.url}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    };
    const { adminA, memberA } = fixture.tokens;
    const item = (id: string, originalScope: string | null, second: number) => ({
      id, originalScope, reason: 'test', status: 'pending', quarantinedAt: heldAt(second), decidedAt: null, decidedBy: null, contentPreview: heldContent(id),
    });
    expect(await call(adminA, 'GET', '/v1/quarantine')).toEqual({
      status: 200,
      body: { quarantine: [item(HELD.moved, 'team:alpha', 4), item(HELD.a3, 'team:alpha', 2), item(HELD.a2, null, 2), item(HELD.a1, 'team:alpha', 1)], next_cursor: null },
    });
    expect((await call(memberA, 'GET', '/v1/quarantine')).status).toBe(403);
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a1}/approve`)).toEqual({ status: 200, body: { approved: HELD.a1 } });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a1}/approve`)).toEqual({ status: 409, body: { error: `${HELD.a1} is already approved` } });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.moved}/approve`)).toEqual({
      status: 409, body: { error: `memory ${HELD.moved} scope changed since quarantine; refusing to approve` },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a2}/reject`)).toEqual({ status: 200, body: { rejected: HELD.a2 } });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a2}/reject`)).toEqual({ status: 409, body: { error: `${HELD.a2} is already rejected` } });
    expect(await call(adminB, 'POST', `/v1/quarantine/${HELD.a3}/approve`)).toEqual({ status: 404, body: { error: `not quarantined: ${HELD.a3}` } });
    expect(await call(adminB, 'POST', `/v1/quarantine/${HELD.a3}/reject`)).toEqual({ status: 404, body: { error: `not quarantined: ${HELD.a3}` } });
    expect(await call(adminA, 'GET', '/v1/quarantine?status=all&limit=2')).toMatchObject({
      status: 200, body: { quarantine: [{ id: HELD.moved, status: 'pending' }, { id: HELD.gone, contentPreview: '' }], next_cursor: expect.any(String) },
    });
    expect(await call(adminA, 'GET', '/v1/quarantine?status=approved')).toMatchObject({
      status: 200, body: { quarantine: [{ id: HELD.a1, status: 'approved', decidedBy: `api_key:${fixture.keys.adminA}` }], next_cursor: null },
    });
    const actor = `api_key:${fixture.keys.adminA}`;
    expect(memory.auditRows().slice(-2).map((e) => [e.op, e.actor, e.tenantId, e.targetId])).toEqual([
      ['quarantine_approve', actor, TENANT_A, HELD.a1], ['quarantine_reject', actor, TENANT_A, HELD.a2],
    ]);
    expect(hippoDbRows()).toEqual(before);
  });
});

describe('serve() under a store that has the graphReads group', () => {
  let fixture: TwoTenantFixture;
  let graph: SeededGraph;
  let handle: ServerHandle;

  const hippoDbRows = () => {
    const db = openHippoDb(fixture.dir);
    try {
      // SAFETY: each SELECT names the one column n.
      const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return { entities: count('entities'), relations: count('relations'), memories: count('memories'), audit: count('audit_log') };
    } finally {
      closeHippoDb(db);
    }
  };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    fixture = seedTwoTenants();
    graph = seedGraphRows(fixture.dir);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: inMemoryGraphReadsStore(fixture.dir).store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("serves GET /v1/graph from that store, inside the caller's tenant and under the caller's scopes, and writes nothing to hippo.db", async () => {
    const before = hippoDbRows();
    const get = async (token: string, path: string): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${handle.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    };
    const { adminA, memberA, memberB } = fixture.tokens;
    const { e } = graph;
    const node = (id: number, type: string, name: string) => ({ id, type, name });
    const edge = (from: number, to: number) => ({ from, to, relType: 'references' });
    const hub = node(e.hub, 'project', 'Hub');
    const spokes = [node(e.spoke1, 'system', 'Spoke'), node(e.spoke2, 'project', 'Spoke')];
    const shared = node(e.shared, 'project', 'Shared');
    const amongSpokes = [edge(e.spoke1, e.spoke2), edge(e.hub, e.spoke2), edge(e.hub, e.spoke1)];
    // An admin reads the held scope and not another person's own: Mine is gone, and with it the relation that ends there.
    expect(await get(adminA, '/v1/graph')).toEqual({
      status: 200,
      body: {
        nodes: [
          node(e.anchored, 'policy', 'Anchored'), shared, node(e.lone, 'decision', 'Lone'), node(e.twinOpen, 'person', 'Twin'), node(e.twinHeld, 'person', 'Twin'),
          node(e.secret, 'customer', 'Secret'), spokes[1], spokes[0], hub,
        ],
        edges: [edge(e.shared, e.hub), edge(e.hub, e.secret), ...amongSpokes],
        truncated: false,
      },
    });
    expect(await get(memberA, '/v1/graph?entity=Hub')).toEqual({
      status: 200, body: { nodes: [hub, ...spokes, shared], edges: [edge(e.shared, e.hub), ...amongSpokes], truncated: false },
    });
    expect(await get(memberA, '/v1/graph?entity=Secret')).toEqual({ status: 200, body: { nodes: [], edges: [], truncated: false } });
    expect(await get(adminA, '/v1/graph?entity=Hub&limit=2')).toEqual({ status: 200, body: { nodes: [hub, shared], edges: [edge(e.shared, e.hub)], truncated: true } });
    expect(await get(memberB, '/v1/graph?entity=Shared')).toEqual({
      status: 200, body: { nodes: [node(e.sharedB, 'project', 'Shared'), node(e.otherB, 'system', 'Other')], edges: [edge(e.sharedB, e.otherB)], truncated: false },
    });
    expect(await get(adminA, '/v1/graph?limit=0')).toEqual({ status: 400, body: { error: 'limit must be a positive integer <= 1000' } });
    expect(hippoDbRows()).toEqual(before);
  });
});

describe('serve() under a store that has the objects group', () => {
  let fixture: TwoTenantFixture;
  let memory: InMemoryObjectsStore;
  let handle: ServerHandle;

  type RouteBody = Readonly<Record<string, string | boolean | readonly string[]>>;

  /** One savable kind's routes: its reply fields, a create body, a successor body and the status its supersede answers. */
  interface SavedKind {
    readonly path: string;
    readonly one: string;
    readonly many: string;
    readonly create: RouteBody;
    readonly revise: RouteBody;
    readonly revised: number;
  }

  const SAVED: readonly SavedKind[] = [
    { path: '/v1/decisions', one: 'decision', many: 'decisions', create: { text: 'ship on friday' }, revise: { text: 'ship on monday' }, revised: 201 },
    { path: '/v1/processes', one: 'process', many: 'processes', create: { processName: 'release', steps: ['tag', 'publish'] }, revise: { steps: ['tag', 'publish', 'announce'] }, revised: 200 },
    { path: '/v1/policies', one: 'policy', many: 'policies', create: { policyName: 'retention', policyText: 'keep logs 30 days' }, revise: { policyText: 'keep logs 90 days' }, revised: 200 },
    { path: '/v1/skills', one: 'skill', many: 'skills', create: { skillName: 'triage', instructions: 'read the log first' }, revise: { instructions: 'read the trace first' }, revised: 200 },
    { path: '/v1/project-briefs', one: 'brief', many: 'briefs', create: { repo: 'hippo', summary: 'memory for agents' }, revise: { summary: 'zero-touch memory' }, revised: 200 },
    { path: '/v1/customer-notes', one: 'note', many: 'notes', create: { customer: 'acme', note: 'renewal in march' }, revise: { note: 'renewed' }, revised: 200 },
  ];
  const TABLES = ['decisions', 'incidents', 'processes', 'policies', 'skills', 'project_briefs', 'customer_notes', 'memories', 'audit_log'];

  const hippoDbRows = (): number[] => {
    const db = openHippoDb(fixture.dir);
    try {
      // SAFETY: each SELECT names the one column n.
      return TABLES.map((table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    } finally {
      closeHippoDb(db);
    }
  };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    fixture = seedTwoTenants();
    memory = inMemoryObjectsStore(fixture.dir);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: memory.store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('runs every route ported to the group on that store, inside the caller\'s tenant, and writes nothing to hippo.db', async () => {
    const before = hippoDbRows();
    const { memberA, memberB } = fixture.tokens;
    const answered = new Set<string>();
    const call = async (token: string, method: string, path: string, body?: RouteBody): Promise<{ status: number; body: unknown }> => {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const res = await fetch(`${handle.url}${path}`, { method, headers, body: body && JSON.stringify(body) });
      if (token === memberA && res.status < 300) answered.add(`${method} ${path.replace(/\?.*$/, '').replace(/\/\d+/g, '/1')}`);
      return { status: res.status, body: await res.json() };
    };
    for (const k of SAVED) {
      expect(await call(memberA, 'POST', k.path, k.create)).toMatchObject({ status: 201, body: { [k.one]: { id: 1, tenantId: TENANT_A, status: 'active' } } });
      expect(await call(memberA, 'GET', k.path)).toMatchObject({ status: 200, body: { [k.many]: [{ id: 1 }], next_cursor: null } });
      expect(await call(memberA, 'GET', `${k.path}/1`)).toMatchObject({ status: 200, body: { [k.one]: { id: 1 } } });
      expect(await call(memberA, 'POST', `${k.path}/1/supersede`, k.revise)).toMatchObject({ status: k.revised, body: { [k.one]: { id: 2, status: 'active' } } });
      expect(await call(memberA, 'GET', `${k.path}?status=superseded`)).toMatchObject({ status: 200, body: { [k.many]: [{ id: 1, supersededBy: 2 }] } });
      expect(await call(memberA, 'POST', `${k.path}/2/close`, {})).toMatchObject({ status: 200, body: { [k.one]: { id: 2, status: 'closed' } } });
      expect(await call(memberB, 'GET', k.path)).toEqual({ status: 200, body: { [k.many]: [], next_cursor: null } });
      expect((await call(memberB, 'GET', `${k.path}/1`)).status).toBe(404);
      expect((await call(memberB, 'POST', `${k.path}/1/supersede`, k.revise)).status).toBe(404);
    }
    expect(await call(memberA, 'POST', '/v1/policies', { policyName: 'access', policyText: 'two reviewers', validFrom: '2026-01-01' })).toMatchObject({ status: 201, body: { policy: { id: 3 } } });
    expect(await call(memberA, 'GET', '/v1/policies/asof?date=2026-02-01')).toMatchObject({ status: 200, body: { policies: [{ id: 3, policyName: 'access' }] } });
    expect(await call(memberA, 'GET', '/v1/policies/asof?date=2025-12-31')).toEqual({ status: 200, body: { policies: [] } });
    expect(await call(memberB, 'GET', '/v1/policies/asof?date=2026-02-01')).toEqual({ status: 200, body: { policies: [] } });
    expect(await call(memberA, 'POST', '/v1/skills', { skillName: 'deploy', instructions: 'tag then publish' })).toMatchObject({ status: 201, body: { skill: { id: 3 } } });
    expect(await call(memberA, 'GET', '/v1/skills/export')).toEqual({ status: 200, body: { markdown: '## deploy\n\ntag then publish' } });
    expect(await call(memberB, 'GET', '/v1/skills/export')).toEqual({ status: 200, body: { markdown: '' } });
    expect(await call(memberA, 'POST', '/v1/project-briefs/refresh', { repo: 'hippo', dryRun: true })).toMatchObject({ status: 200, body: { receiptCount: 0 } });
    expect(await call(memberA, 'POST', '/v1/project-briefs/refresh', { repo: 'hippo' })).toMatchObject({ status: 200, body: { brief: { id: 3, repo: 'hippo', version: 1, status: 'active' } } });
    expect(await call(memberA, 'POST', '/v1/project-briefs/refresh', { repo: 'hippo' })).toMatchObject({
      status: 200, body: { brief: { id: 4, version: 2, changeSummary: 'auto-refresh from 0 receipt(s)', summary: expect.stringContaining('# Project Brief: hippo') } },
    });
    expect(await call(memberA, 'GET', '/v1/project-briefs?status=superseded')).toMatchObject({ status: 200, body: { briefs: [{ id: 3, supersededBy: 4 }, { id: 1 }] } });

    expect(await call(memberA, 'POST', '/v1/incidents', { text: 'checkout latency' })).toMatchObject({ status: 201, body: { incident: { id: 1, tenantId: TENANT_A, status: 'open' } } });
    expect(await call(memberA, 'POST', '/v1/incidents', { text: 'no evidence', linkedMemoryIds: ['mem_never_written'] })).toEqual({
      status: 409, body: { error: `saveIncident: linked memory mem_never_written not found for tenant ${TENANT_A}` },
    });
    expect(await call(memberA, 'GET', '/v1/incidents')).toMatchObject({ status: 200, body: { incidents: [{ id: 1, status: 'open' }], next_cursor: null } });
    expect(await call(memberA, 'GET', '/v1/incidents/1')).toMatchObject({ status: 200, body: { incident: { id: 1, incidentText: 'checkout latency' } } });
    expect((await call(memberB, 'POST', '/v1/incidents/1/resolve', { resolutionText: 'not ours' })).status).toBe(404);
    expect(await call(memberA, 'POST', '/v1/incidents/1/resolve', { resolutionText: 'scaled the pool' })).toMatchObject({
      status: 200, body: { incident: { id: 1, status: 'resolved', resolutionText: 'scaled the pool' } },
    });
    expect((await call(memberA, 'POST', '/v1/incidents/1/resolve', { resolutionText: 'again' })).status).toBe(409);
    expect((await call(memberB, 'POST', '/v1/incidents/1/close', {})).status).toBe(404);
    expect(await call(memberA, 'POST', '/v1/incidents/1/close', {})).toMatchObject({ status: 200, body: { incident: { id: 1, status: 'closed' } } });

    const ported = v1Routes().filter((r) => r.group === 'objects').map((r) => r.route);
    expect(ported).toHaveLength(38);
    expect([...answered].sort()).toEqual([...ported].sort());
    const actor = `api_key:${fixture.keys.memberA}`;
    expect(memory.auditRows().slice(-7).map((e) => [e.op, e.actor, e.tenantId])).toEqual([
      ['project_brief_supersede', actor, TENANT_A], ['project_brief_create', actor, TENANT_A], ['remember', actor, TENANT_A],
      ['incident_open', actor, TENANT_A], ['remember', actor, TENANT_A], ['incident_resolve', actor, TENANT_A], ['incident_close', actor, TENANT_A],
    ]);
    expect(hippoDbRows()).toEqual(before);
  });
});

describe('serve() under another store reads its folder as shared, though no config.json says so', () => {
  let root: string;
  let handle: ServerHandle;
  const alice = newKey();
  const keys: (ContinuityKey | null)[] = [];
  const snapshot = {
    id: 1, task: 'ship the eu cluster', summary: 'cutover planned', next_step: 'run the canary', status: 'active', source: 'cli',
    session_id: 's1', scope: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
  };
  const notRead = async (): Promise<never> => {
    throw new Error('this recall reads nothing else');
  };
  const store: HippoStore = {
    kind: 'stub',
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
    root = mkdtempSync(join(tmpdir(), 'hippo-other-store-shared-'));
    handle = await serve({ hippoRoot: root, port: 0, store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('keys an MCP recall\'s continuity to the caller\'s owner and project', async () => {
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
    expect(await res.json()).toMatchObject({ continuity: { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] } });
  });
});

describe('a store without the vector reads, under an embedding provider', () => {
  let root: string;
  let handle: ServerHandle;
  let embeddings: HashedEmbeddings;
  let store: HippoStore;

  beforeAll(async () => {
    embeddings = await startHashedEmbeddings();
    root = mkdtempSync(join(tmpdir(), 'hippo-no-vector-reads-'));
    initStore(root);
    writeEntry(root, seeded('deploy the api with a blue green rollout', 'mem_deploy', '2026-01-02T00:00:00.000Z'));
    const embeddingsConfig = { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: embeddingsConfig, physics: { enabled: true } }));
    store = portOnlyStoreWithoutVectorReads(root);
    handle = await serve({ hippoRoot: root, port: 0, store });
  });

  beforeEach(() => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_HOME', join(root, 'no-global-store'));
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await handle.stop();
    await embeddings.close();
    rmSync(root, { recursive: true, force: true });
  });

  const auditRowCount = (): number => {
    const db = openHippoDb(root);
    try {
      // SAFETY: COUNT(*) AS n is the only column selected.
      return (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    } finally {
      closeHippoDb(db);
    }
  };

  it('GET /v1/memories in hybrid and physics mode answers 501 store_not_ported, embeds nothing and writes no audit row', async () => {
    expect(store.vectors).toBeUndefined();
    const before = auditRowCount();
    for (const mode of ['hybrid', 'physics']) {
      // With no session_id the route owes a recall_anchor_skipped_no_session row; a recall that fails writes none.
      for (const session of ['', '&session_id=s1']) {
        const res = await fetch(`${handle.url}/v1/memories?q=deploy&mode=${mode}${session}`);
        expect({ mode, session, status: res.status, body: await res.json() }).toEqual({ mode, session, status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
      }
    }
    expect(embeddings.requests()).toBe(0);
    expect(auditRowCount()).toBe(before);
  });

  it('requireVectorReads names the missing group, and that error still maps to the 501', () => {
    expect(() => requireVectorReads(store)).toThrow(StoreNotPortedError);
    expect(() => requireVectorReads(store)).toThrow(SqliteBlockedError);
    expect(() => requireVectorReads(store)).toThrow("the 'port-only' store has no 'vectors' group");
    const err = new StoreNotPortedError('port-only', 'vectors');
    expect(mapApiError(err)).toEqual({ status: 501, message: STORE_NOT_PORTED_MESSAGE });
    expect(() => rethrowIfSqliteBlocked(err)).toThrow(err);
  });

  it('MCP hippo_recall answers -32603 store_not_ported', async () => {
    const body = rpc('tools/call', { name: 'hippo_recall', arguments: { query: 'deploy' } });
    // A shared store refuses hippo_recall from a caller that names no project, before the vector arm.
    const res = await fetch(`${handle.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hippo-project': 'p' }, body });
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } });
    expect(embeddings.requests()).toBe(0);
  });

  it('with no provider key the vector arm never starts, so recall still answers', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const res = await fetch(`${handle.url}/v1/memories?q=deploy&mode=hybrid`);
    expect(res.status).toBe(200);
  });

  it('physicsSearch refuses the store even when the caller brings the query vector', async () => {
    const entries = loadEntriesByIds(root, ['mem_deploy']);
    expect(entries).toHaveLength(1);
    await expect(physicsSearch('deploy', entries, { hippoRoot: root, store, queryEmbedding: hashedVector('deploy') })).rejects.toThrow(SqliteBlockedError);
  });
});

describe('a StoreBusyError on the hippo.db path', () => {
  let root: string;
  let handle: ServerHandle;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-store-busy-'));
    initStore(root);
    const busyKeys: HippoStore = { ...sqliteStore(root), findApiKey: async () => { throw new StoreBusyError(); } };
    handle = await serve({ hippoRoot: root, port: 0, store: busyKeys });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('is a 503 with Retry-After on a /v1 route and on POST /mcp', async () => {
    const headers = { authorization: `Bearer ${newKey().plaintext}`, 'content-type': 'application/json' };
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const [method, path, body] of [['GET', '/v1/memories?q=x', undefined], ['POST', '/mcp', rpc]] as const) {
      const res = await fetch(`${handle.url}${path}`, { method, headers, body });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(await res.json()).toEqual({ error: STORE_BUSY_MESSAGE });
    }
  });

  it('a StoreBusyError thrown inside an MCP tool call answers with the busy message, not an internal error', () => {
    expect(mcpErrorResponse(7, new StoreBusyError())).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: STORE_BUSY_MESSAGE } });
  });
});
