// serve() under a store that has the objects group runs every route ported to it on that store and writes nothing to hippo.db.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import { OBJECT_ROW, V1_ROWS } from '../_helpers/v1-route-rows.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';
import { requestLine } from '../_helpers/other-store-server.js';
import { type MemorySide, memorySide } from '../_helpers/memory-side.js';

describe('serve() under a store that has the objects group', () => {
  let fixture: TwoTenantFixture;
  let memory: MemorySide;
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
    {
      path: '/v1/decisions',
      one: 'decision',
      many: 'decisions',
      create: { text: 'ship on friday' },
      revise: { text: 'ship on monday' },
      revised: 201,
    },
    {
      path: '/v1/processes',
      one: 'process',
      many: 'processes',
      create: { processName: 'release', steps: ['tag', 'publish'] },
      revise: { steps: ['tag', 'publish', 'announce'] },
      revised: 200,
    },
    {
      path: '/v1/policies',
      one: 'policy',
      many: 'policies',
      create: { policyName: 'retention', policyText: 'keep logs 30 days' },
      revise: { policyText: 'keep logs 90 days' },
      revised: 200,
    },
    {
      path: '/v1/skills',
      one: 'skill',
      many: 'skills',
      create: { skillName: 'triage', instructions: 'read the log first' },
      revise: { instructions: 'read the trace first' },
      revised: 200,
    },
    {
      path: '/v1/project-briefs',
      one: 'brief',
      many: 'briefs',
      create: { repo: 'hippo', summary: 'memory for agents' },
      revise: { summary: 'zero-touch memory' },
      revised: 200,
    },
    {
      path: '/v1/customer-notes',
      one: 'note',
      many: 'notes',
      create: { customer: 'acme', note: 'renewal in march' },
      revise: { note: 'renewed' },
      revised: 200,
    },
  ];
  const TABLES = [
    'decisions',
    'incidents',
    'processes',
    'policies',
    'skills',
    'project_briefs',
    'customer_notes',
    'memories',
    'audit_log',
  ];

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
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    fixture = seedTwoTenants();
    memory = memorySide(fixture.dir);
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: memory.store });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("runs every route ported to the group on that store, inside the caller's tenant, and writes nothing to hippo.db", async () => {
    const before = hippoDbRows();
    const { memberA, memberB } = fixture.tokens;
    const answered = new Set<string>();
    const call = async (
      token: string,
      method: string,
      path: string,
      body?: RouteBody,
    ): Promise<{ status: number; body: unknown }> => {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const res = await fetch(`${handle.url}${path}`, { method, headers, body: body && JSON.stringify(body) });
      if (token === memberA && res.status < 300) {
        answered.add(`${method} ${path.replace(/\?.*$/, '').replace(/\/\d+/g, '/1')}`);
      }
      return { status: res.status, body: await res.json() };
    };
    for (const k of SAVED) {
      expect(await call(memberA, 'POST', k.path, k.create)).toMatchObject({
        status: 201,
        body: { [k.one]: { id: 1, tenantId: TENANT_A, status: 'active' } },
      });
      expect(await call(memberA, 'GET', k.path)).toMatchObject({
        status: 200,
        body: { [k.many]: [{ id: 1 }], next_cursor: null },
      });
      expect(await call(memberA, 'GET', `${k.path}/1`)).toMatchObject({ status: 200, body: { [k.one]: { id: 1 } } });
      expect(await call(memberA, 'POST', `${k.path}/1/supersede`, k.revise)).toMatchObject({
        status: k.revised,
        body: { [k.one]: { id: 2, status: 'active' } },
      });
      expect(await call(memberA, 'GET', `${k.path}?status=superseded`)).toMatchObject({
        status: 200,
        body: { [k.many]: [{ id: 1, supersededBy: 2 }] },
      });
      expect(await call(memberA, 'POST', `${k.path}/2/close`, {})).toMatchObject({
        status: 200,
        body: { [k.one]: { id: 2, status: 'closed' } },
      });
      expect(await call(memberB, 'GET', k.path)).toEqual({ status: 200, body: { [k.many]: [], next_cursor: null } });
      expect((await call(memberB, 'GET', `${k.path}/1`)).status).toBe(404);
      expect((await call(memberB, 'POST', `${k.path}/1/supersede`, k.revise)).status).toBe(404);
    }
    expect(
      await call(memberA, 'POST', '/v1/policies', {
        policyName: 'access',
        policyText: 'two reviewers',
        validFrom: '2026-01-01',
      }),
    ).toMatchObject({ status: 201, body: { policy: { id: 3 } } });
    expect(await call(memberA, 'GET', '/v1/policies/asof?date=2026-02-01')).toMatchObject({
      status: 200,
      body: { policies: [{ id: 3, policyName: 'access' }] },
    });
    expect(await call(memberA, 'GET', '/v1/policies/asof?date=2025-12-31')).toEqual({
      status: 200,
      body: { policies: [] },
    });
    expect(await call(memberB, 'GET', '/v1/policies/asof?date=2026-02-01')).toEqual({
      status: 200,
      body: { policies: [] },
    });
    expect(
      await call(memberA, 'POST', '/v1/skills', { skillName: 'deploy', instructions: 'tag then publish' }),
    ).toMatchObject({ status: 201, body: { skill: { id: 3 } } });
    expect(await call(memberA, 'GET', '/v1/skills/export')).toEqual({
      status: 200,
      body: { markdown: '## deploy\n\ntag then publish' },
    });
    expect(await call(memberB, 'GET', '/v1/skills/export')).toEqual({ status: 200, body: { markdown: '' } });
    expect(await call(memberA, 'POST', '/v1/project-briefs/refresh', { repo: 'hippo', dryRun: true })).toMatchObject({
      status: 200,
      body: { receiptCount: 0 },
    });
    expect(await call(memberA, 'POST', '/v1/project-briefs/refresh', { repo: 'hippo' })).toMatchObject({
      status: 200,
      body: { brief: { id: 3, repo: 'hippo', version: 1, status: 'active' } },
    });
    expect(await call(memberA, 'POST', '/v1/project-briefs/refresh', { repo: 'hippo' })).toMatchObject({
      status: 200,
      body: {
        brief: {
          id: 4,
          version: 2,
          changeSummary: 'auto-refresh from 0 receipt(s)',
          summary: expect.stringContaining('# Project Brief: hippo'),
        },
      },
    });
    expect(await call(memberA, 'GET', '/v1/project-briefs?status=superseded')).toMatchObject({
      status: 200,
      body: { briefs: [{ id: 3, supersededBy: 4 }, { id: 1 }] },
    });

    expect(await call(memberA, 'POST', '/v1/incidents', { text: 'checkout latency' })).toMatchObject({
      status: 201,
      body: { incident: { id: 1, tenantId: TENANT_A, status: 'open' } },
    });
    expect(
      await call(memberA, 'POST', '/v1/incidents', { text: 'no evidence', linkedMemoryIds: ['mem_never_written'] }),
    ).toEqual({
      status: 409,
      body: { error: `saveIncident: linked memory mem_never_written not found for tenant ${TENANT_A}` },
    });
    expect(await call(memberA, 'GET', '/v1/incidents')).toMatchObject({
      status: 200,
      body: { incidents: [{ id: 1, status: 'open' }], next_cursor: null },
    });
    expect(await call(memberA, 'GET', '/v1/incidents/1')).toMatchObject({
      status: 200,
      body: { incident: { id: 1, incidentText: 'checkout latency' } },
    });
    expect((await call(memberB, 'POST', '/v1/incidents/1/resolve', { resolutionText: 'not ours' })).status).toBe(404);
    expect(await call(memberA, 'POST', '/v1/incidents/1/resolve', { resolutionText: 'scaled the pool' })).toMatchObject(
      {
        status: 200,
        body: { incident: { id: 1, status: 'resolved', resolutionText: 'scaled the pool' } },
      },
    );
    expect((await call(memberA, 'POST', '/v1/incidents/1/resolve', { resolutionText: 'again' })).status).toBe(409);
    expect((await call(memberB, 'POST', '/v1/incidents/1/close', {})).status).toBe(404);
    expect(await call(memberA, 'POST', '/v1/incidents/1/close', {})).toMatchObject({
      status: 200,
      body: { incident: { id: 1, status: 'closed' } },
    });

    const ported = V1_ROWS.filter(({ key }) => OBJECT_ROW.test(key)).map(({ key }) => requestLine(key));
    expect(ported).toHaveLength(38);
    expect([...answered].sort()).toEqual([...ported].sort());
    const actor = `api_key:${fixture.keys.memberA}`;
    expect(
      memory
        .auditRows()
        .slice(-7)
        .map((e) => [e.op, e.actor, e.tenantId]),
    ).toEqual([
      ['project_brief_supersede', actor, TENANT_A],
      ['project_brief_create', actor, TENANT_A],
      ['remember', actor, TENANT_A],
      ['incident_open', actor, TENANT_A],
      ['remember', actor, TENANT_A],
      ['incident_resolve', actor, TENANT_A],
      ['incident_close', actor, TENANT_A],
    ]);
    expect(hippoDbRows()).toEqual(before);
  });
});
