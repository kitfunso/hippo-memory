// Under a store other than hippo.db, a route not yet ported to it answers 501 and no request opens or creates hippo.db.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeHippoDb, openHippoDb, rethrowIfSqliteBlocked, SqliteBlockedError, STORE_BUSY_MESSAGE } from '../src/db.js';
import { StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { VERIFIED_KEY_TTL_MS } from '../src/auth.js';
import { mapApiError, STORE_NOT_PORTED_MESSAGE } from '../src/http-util.js';
import { mcpErrorResponse, type McpRequest } from '../src/mcp/server.js';
import { initStore } from '../src/store/open.js';
import { serve, sqliteStore, StoreBusyError, type ApiKeyRecord, type ContinuityKey, type HippoStore, type ServerHandle } from '../src/server.js';
import { physicsSearch } from '../src/search/physics-search.js';
import { requireVectorReads } from '../src/search/vector.js';
import { loadEntriesByIds } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { portOnlyStoreWithoutVectorReads } from './_helpers/port-only-store.js';
import { seeded } from './_helpers/recall-golden-seed.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverSource = readFileSync(join(repoRoot, 'src/server/route-table.ts'), 'utf8');

/** 'METHOD /path' for every V1_ROUTES entry the stub store cannot run (no group named, or one besides 'base'), each :param and (\d+) slot filled with 1. */
function unportedV1Routes(): string[] {
  const table = serverSource.slice(serverSource.indexOf('const V1_ROUTES'), serverSource.indexOf('async function dispatchV1Route'));
  const routes: string[] = [];
  for (const m of table.matchAll(/\{ method: '([A-Z]+)', (?:path|pattern): '([^']+)'(?:, storeReady: '(\w+)')?/g)) {
    if (m[3] !== 'base') routes.push(`${m[1]} ${m[2]!.replace(/:\w+/g, '1')}`);
  }
  for (const m of table.matchAll(/\{ method: '([A-Z]+)', regex: \/\^(.+?)\$\/(?:, storeReady: '(\w+)')?/g)) {
    if (m[3] !== 'base') routes.push(`${m[1]} ${m[2]!.replace(/\\\//g, '/').replace(/\(\\d\+\)/g, '1')}`);
  }
  return routes;
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

  afterEach(() => {
    vi.useRealTimers();
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

  it('caches a verified key until the TTL runs out, then asks the store again', async () => {
    const key = newKey();
    records.set(key.keyId, key.record);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    const statusOf = async (): Promise<number> => (await fetch(`${handle.url}/v1/audit`, { headers: bearer(key) })).status;
    expect([await statusOf(), await statusOf()]).toEqual([501, 501]);
    expect(lookups.get(key.keyId)).toBe(1);
    vi.setSystemTime(Date.now() + VERIFIED_KEY_TTL_MS - 1);
    expect(await statusOf()).toBe(501);
    expect(lookups.get(key.keyId)).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    expect(await statusOf()).toBe(501);
    expect(lookups.get(key.keyId)).toBe(2);
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
