// serve() under a store that has the predictions, quarantine or graphReads group runs those routes on it, and one
// without a feature group answers 501 on that group's routes from boot.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';
import { type PortOnlySide, portOnlySide } from '../_helpers/port-only-store.js';
import { seedGraphRows, type SeededGraph } from '../_helpers/graph-reads-seed.js';
import { HELD, heldAt, heldContent, seedQuarantineRecords } from '../_helpers/quarantine-seed.js';

describe('serve() under a store that has the predictions group', () => {
  let fixture: TwoTenantFixture;
  let side: PortOnlySide<'objects'>;
  let handle: ServerHandle;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    fixture = seedTwoTenants();
    side = portOnlySide(fixture.dir, ['objects']);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: side.store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("runs the five predictions routes on that store, inside the caller's tenant", async () => {
    const call = async (
      token: string,
      method: string,
      path: string,
      body?: string,
    ): Promise<{ status: number; body: unknown }> => {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const res = await fetch(`${handle.url}${path}`, { method, headers, body });
      return { status: res.status, body: await res.json() };
    };
    const { memberA, memberB } = fixture.tokens;
    expect(
      await call(
        memberA,
        'POST',
        '/v1/predictions',
        '{"claim":"the cutover takes two days","classTag":"cutover","estimate":2}',
      ),
    ).toMatchObject({
      status: 201,
      body: { prediction: { id: 1, tenantId: TENANT_A, classTag: 'cutover', estimateValue: 2, closureState: 'open' } },
    });
    expect(await call(memberA, 'GET', '/v1/predictions?status=open')).toMatchObject({
      status: 200,
      body: { predictions: [{ id: 1 }], next_cursor: null },
    });
    expect(await call(memberA, 'GET', '/v1/predictions/1')).toMatchObject({
      status: 200,
      body: { prediction: { id: 1, claimText: 'the cutover takes two days' } },
    });
    expect(await call(memberA, 'POST', '/v1/predictions/1/close', '{"state":"closed","actual":3}')).toMatchObject({
      status: 200,
      body: { prediction: { id: 1, closureState: 'closed', actualValue: 3 } },
    });
    expect(await call(memberA, 'GET', '/v1/predictions/stats?class=cutover')).toMatchObject({
      status: 200,
      body: { baserate: { nClosed: 1, meanRatio: 1.5 } },
    });
    expect(await call(memberB, 'GET', '/v1/predictions')).toEqual({
      status: 200,
      body: { predictions: [], next_cursor: null },
    });
    expect((await call(memberB, 'GET', '/v1/predictions/1')).status).toBe(404);
    expect((await call(memberB, 'POST', '/v1/predictions/1/close', '{"state":"closed","actual":3}')).status).toBe(404);
    const actor = `api_key:${fixture.keys.memberA}`;
    expect(
      side
        .auditRows()
        .slice(-4)
        .map((e) => [e.op, e.actor, e.tenantId]),
    ).toEqual([
      ['predict_create', actor, TENANT_A],
      ['remember', actor, TENANT_A],
      ['predict_close', actor, TENANT_A],
      ['predict_baserate', actor, TENANT_A],
    ]);
  });
});

describe('serve() under a store that has the quarantine group', () => {
  let fixture: TwoTenantFixture;
  let side: PortOnlySide<'quarantine'>;
  let handle: ServerHandle;
  let adminB: string;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    fixture = seedTwoTenants();
    adminB = seedQuarantineRecords(fixture.dir);
    side = portOnlySide(fixture.dir, ['quarantine']);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: side.store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("runs the three quarantine routes on that store, inside the caller's tenant", async () => {
    const call = async (token: string, method: string, path: string): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${handle.url}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    };
    const { adminA, memberA } = fixture.tokens;
    const item = (id: string, originalScope: string | null, second: number) => ({
      id,
      originalScope,
      reason: 'test',
      status: 'pending',
      quarantinedAt: heldAt(second),
      decidedAt: null,
      decidedBy: null,
      contentPreview: heldContent(id),
    });
    expect(await call(adminA, 'GET', '/v1/quarantine')).toEqual({
      status: 200,
      body: {
        quarantine: [
          item(HELD.moved, 'team:alpha', 4),
          item(HELD.a3, 'team:alpha', 2),
          item(HELD.a2, null, 2),
          item(HELD.a1, 'team:alpha', 1),
        ],
        next_cursor: null,
      },
    });
    expect((await call(memberA, 'GET', '/v1/quarantine')).status).toBe(403);
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a1}/approve`)).toEqual({
      status: 200,
      body: { approved: HELD.a1 },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a1}/approve`)).toEqual({
      status: 409,
      body: { error: `${HELD.a1} is already approved` },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.moved}/approve`)).toEqual({
      status: 409,
      body: { error: `memory ${HELD.moved} scope changed since quarantine; refusing to approve` },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a2}/reject`)).toEqual({
      status: 200,
      body: { rejected: HELD.a2 },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a2}/reject`)).toEqual({
      status: 409,
      body: { error: `${HELD.a2} is already rejected` },
    });
    expect(await call(adminB, 'POST', `/v1/quarantine/${HELD.a3}/approve`)).toEqual({
      status: 404,
      body: { error: `not quarantined: ${HELD.a3}` },
    });
    expect(await call(adminB, 'POST', `/v1/quarantine/${HELD.a3}/reject`)).toEqual({
      status: 404,
      body: { error: `not quarantined: ${HELD.a3}` },
    });
    expect(await call(adminA, 'GET', '/v1/quarantine?status=all&limit=2')).toMatchObject({
      status: 200,
      body: {
        quarantine: [
          { id: HELD.moved, status: 'pending' },
          { id: HELD.gone, contentPreview: '' },
        ],
        next_cursor: expect.any(String),
      },
    });
    expect(await call(adminA, 'GET', '/v1/quarantine?status=approved')).toMatchObject({
      status: 200,
      body: {
        quarantine: [{ id: HELD.a1, status: 'approved', decidedBy: `api_key:${fixture.keys.adminA}` }],
        next_cursor: null,
      },
    });
    const actor = `api_key:${fixture.keys.adminA}`;
    expect(
      side
        .auditRows()
        .slice(-2)
        .map((e) => [e.op, e.actor, e.tenantId, e.targetId]),
    ).toEqual([
      ['quarantine_approve', actor, TENANT_A, HELD.a1],
      ['quarantine_reject', actor, TENANT_A, HELD.a2],
    ]);
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
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return {
        entities: count('entities'),
        relations: count('relations'),
        memories: count('memories'),
        audit: count('audit_log'),
      };
    } finally {
      closeHippoDb(db);
    }
  };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    fixture = seedTwoTenants();
    graph = await seedGraphRows(fixture.dir);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: portOnlySide(fixture.dir, ['graphReads']).store });
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
          node(e.anchored, 'policy', 'Anchored'),
          shared,
          node(e.lone, 'decision', 'Lone'),
          node(e.twinOpen, 'person', 'Twin'),
          node(e.twinHeld, 'person', 'Twin'),
          node(e.secret, 'customer', 'Secret'),
          spokes[1],
          spokes[0],
          hub,
        ],
        edges: [edge(e.shared, e.hub), edge(e.hub, e.secret), ...amongSpokes],
        truncated: false,
      },
    });
    expect(await get(memberA, '/v1/graph?entity=Hub')).toEqual({
      status: 200,
      body: { nodes: [hub, ...spokes, shared], edges: [edge(e.shared, e.hub), ...amongSpokes], truncated: false },
    });
    expect(await get(memberA, '/v1/graph?entity=Secret')).toEqual({
      status: 200,
      body: { nodes: [], edges: [], truncated: false },
    });
    expect(await get(adminA, '/v1/graph?entity=Hub&limit=2')).toEqual({
      status: 200,
      body: { nodes: [hub, shared], edges: [edge(e.shared, e.hub)], truncated: true },
    });
    expect(await get(memberB, '/v1/graph?entity=Shared')).toEqual({
      status: 200,
      body: {
        nodes: [node(e.sharedB, 'project', 'Shared'), node(e.otherB, 'system', 'Other')],
        edges: [edge(e.sharedB, e.otherB)],
        truncated: false,
      },
    });
    expect(await get(adminA, '/v1/graph?limit=0')).toEqual({
      status: 400,
      body: { error: 'limit must be a positive integer <= 1000' },
    });
    expect(hippoDbRows()).toEqual(before);
  });
});

describe('serve() under a store without the feature groups', () => {
  let fixture: TwoTenantFixture;
  let handle: ServerHandle;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    fixture = seedTwoTenants();
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: portOnlySide(fixture.dir).store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    token?: string,
    body = '{}',
  ): Promise<{ status: number; body: unknown }> => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-hippo-project': 'proj' });
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(`${handle.url}${path}`, { method, headers, body: method === 'GET' ? undefined : body });
    return { status: res.status, body: await res.json() };
  };
  const refused = { status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } };

  it('answers 501 on an objects or quarantine route after the key checks out, and a bad key is still a 401', async () => {
    const { adminA, revokedA } = fixture.tokens;
    expect(await call('GET', '/v1/predictions', adminA)).toEqual(refused);
    expect(await call('GET', '/v1/quarantine', adminA)).toEqual(refused);
    expect((await call('GET', '/v1/predictions', revokedA)).status).toBe(401);
  });

  it('answers 501 on graph, nearest, drill and assemble after the key check, and serves remember, recall and context', async () => {
    const { adminA, revokedA } = fixture.tokens;
    expect(await call('GET', '/v1/graph?entity=Shared', adminA)).toEqual(refused);
    expect(await call('POST', '/v1/vectors/nearest', adminA, JSON.stringify({ ids: ['mem_x'] }))).toEqual(refused);
    expect(await call('GET', '/v1/recall/drill/sum_x', adminA)).toEqual(refused);
    expect(await call('GET', '/v1/sessions/sess-x/assemble', adminA)).toEqual(refused);
    expect((await call('GET', '/v1/graph?entity=Shared', revokedA)).status).toBe(401);

    const content = 'the four required groups serve the core paths';
    expect((await call('POST', '/v1/memories', adminA, JSON.stringify({ content }))).status).toBe(200);
    const recalled = await call('GET', '/v1/memories?q=required%20groups', adminA);
    expect(recalled.status).toBe(200);
    expect(JSON.stringify(recalled.body)).toContain(content);
    const context = await call('GET', '/v1/context?q=required%20groups&project=proj', adminA);
    expect(context.status).toBe(200);
    expect(JSON.stringify(context.body)).toContain(content);
  });

  it('answers 501 on both connector webhooks before reading the body', async () => {
    expect(await call('POST', '/v1/connectors/slack/events')).toEqual(refused);
    expect(await call('POST', '/v1/connectors/github/events')).toEqual(refused);
  });
});
