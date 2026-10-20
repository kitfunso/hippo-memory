// Route rules every typed object shares over HTTP, one table row per kind; a rule only one kind has stays in its
// http-<kind> test. One server serves the whole file, so the request limits are off and every test makes its own rows.
import { describe, it, expect, vi } from 'vitest';
import type { JsonValue } from '../../src/base/util/json.js';
import { type Body, handle, apiKeyB, useObjectsServer, jsonAs, post, get } from '../_helpers/http-objects-server.js';

useObjectsServer();

interface Wire {
  id: number;
  status: string;
  supersededBy?: number | null;
  [key: string]: JsonValue | undefined;
}

interface Revision {
  readonly body: Body;
  readonly status: number;
  readonly successor: Body;
  readonly again: Body;
}

interface Kind {
  readonly kind: string;
  readonly root: string;
  readonly field: string;
  readonly listField: string;
  readonly create: Body;
  readonly created: Body;
  readonly supersede?: Revision;
}

type Superseding = Kind & { readonly supersede: Revision };

const KINDS: readonly Kind[] = [
  {
    kind: 'decision',
    root: '/v1/decisions',
    field: 'decision',
    listField: 'decisions',
    create: { text: 'use Postgres', context: 'scale' },
    created: { decisionText: 'use Postgres', context: 'scale', status: 'active' },
    // Decisions answer a supersede with 201 because the route saves a new decision.
    supersede: {
      body: { text: 'use GraphQL' },
      status: 201,
      successor: { status: 'active' },
      again: { text: 'third' },
    },
  },
  {
    kind: 'customer note',
    root: '/v1/customer-notes',
    field: 'note',
    listField: 'notes',
    create: { customer: 'Acme', note: 'renewal call' },
    created: { customer: 'Acme', note: 'renewal call', version: 1, status: 'active' },
    supersede: {
      body: { note: 'b', changeSummary: 'x' },
      status: 200,
      successor: { version: 2 },
      again: { note: 'c' },
    },
  },
  {
    kind: 'policy',
    root: '/v1/policies',
    field: 'policy',
    listField: 'policies',
    create: { policyName: 'Retention', policyText: 'delete after 90d', validFrom: '2026-01-01' },
    created: { policyName: 'Retention', validFrom: '2026-01-01T00:00:00.000Z', version: 1, status: 'active' },
    supersede: {
      body: { policyText: 'b', changeSummary: 'x' },
      status: 200,
      successor: { version: 2 },
      again: { policyText: 'c' },
    },
  },
  {
    kind: 'process',
    root: '/v1/processes',
    field: 'process',
    listField: 'processes',
    create: { processName: 'Release', steps: ['test', 'bump', 'publish'], description: 'the ritual' },
    created: { processName: 'Release', steps: ['test', 'bump', 'publish'], version: 1, status: 'active' },
    supersede: {
      body: { steps: ['x', 'y'], changeSummary: 'added y' },
      status: 200,
      successor: { version: 2, changeSummary: 'added y' },
      again: { steps: ['z'] },
    },
  },
  {
    kind: 'project brief',
    root: '/v1/project-briefs',
    field: 'brief',
    listField: 'briefs',
    create: { repo: 'hippo', summary: 'agent-memory lib' },
    created: { repo: 'hippo', summary: 'agent-memory lib', version: 1, status: 'active' },
    supersede: {
      body: { summary: 'b', changeSummary: 'x' },
      status: 200,
      successor: { version: 2 },
      again: { summary: 'c' },
    },
  },
  {
    kind: 'skill',
    root: '/v1/skills',
    field: 'skill',
    listField: 'skills',
    create: { skillName: 'Run tests', instructions: 'npm test', trigger: 'before commit' },
    created: { skillName: 'Run tests', trigger: 'before commit', version: 1, status: 'active' },
    supersede: {
      body: { instructions: 'b', changeSummary: 'x' },
      status: 200,
      successor: { version: 2 },
      again: { instructions: 'c' },
    },
  },
  {
    kind: 'incident',
    root: '/v1/incidents',
    field: 'incident',
    listField: 'incidents',
    create: { text: 'DB pool exhausted', context: 'spike at 14:00' },
    created: { incidentText: 'DB pool exhausted', context: 'spike at 14:00', status: 'open', linkedMemoryIds: [] },
  },
];

const SUPERSEDING = KINDS.filter((k): k is Superseding => k.supersede !== undefined);

async function one(res: Response, field: string): Promise<Wire> {
  return (await jsonAs<Record<string, Wire>>(res))[field];
}

async function created(k: Kind): Promise<Wire> {
  const res = await post(k.root, k.create);
  expect(res.status).toBe(201);
  return one(res, k.field);
}

describe.each(KINDS)('HTTP $root ($kind)', (k) => {
  it('create answers 201 with the row; get finds it by id and answers 404 for a missing id', async () => {
    const row = await created(k);
    expect(row).toMatchObject(k.created);
    // Each kind has its own AUTOINCREMENT table, and this test writes its first row.
    expect(row.id).toBe(1);

    const getRes = await get(`${k.root}/${row.id}`);
    expect(getRes.status).toBe(200);
    expect((await one(getRes, k.field)).id).toBe(row.id);
    expect((await get(`${k.root}/99999`)).status).toBe(404);
  });

  it('close answers the closed row, and a second close answers 409', async () => {
    const row = await created(k);
    const closeRes = await post(`${k.root}/${row.id}/close`);
    expect(closeRes.status).toBe(200);
    expect((await one(closeRes, k.field)).status).toBe('closed');
    expect((await post(`${k.root}/${row.id}/close`)).status).toBe(409);
  });

  it('the create route is auth-gated: HIPPO_REQUIRE_AUTH=1 and no Authorization answers 401', async () => {
    // The server lets loopback in without a key by design; HIPPO_REQUIRE_AUTH=1 must close that per route.
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
    const res = await fetch(`${handle.url}${k.root}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(k.create),
    });
    expect(res.status).toBe(401);
  });

  it('cross-tenant isolation: tenant-b neither lists nor gets a default-tenant row', async () => {
    const row = await created(k);
    const bList = await jsonAs<Record<string, Wire[]>>(await get(k.root, apiKeyB));
    expect(bList[k.listField]).toEqual([]);
    expect((await get(`${k.root}/${row.id}`, apiKeyB)).status).toBe(404);
  });

  it('a list limit must be a positive integer (400, not a 500 from SQLite)', async () => {
    for (const bad of ['1.5', 'abc', '0']) {
      expect((await get(`${k.root}?limit=${bad}`)).status).toBe(400);
    }
    expect((await get(`${k.root}?limit=5`)).status).toBe(200);
  });
});

describe.each(SUPERSEDING)('HTTP $root/:id/supersede ($kind)', (k) => {
  it('answers the successor, marks the old row superseded by it, and a second supersede answers 409', async () => {
    const old = await created(k);
    const supRes = await post(`${k.root}/${old.id}/supersede`, k.supersede.body);
    expect(supRes.status).toBe(k.supersede.status);
    const successor = await one(supRes, k.field);
    expect(successor).toMatchObject(k.supersede.successor);

    const reload = await one(await get(`${k.root}/${old.id}`), k.field);
    expect(reload.status).toBe('superseded');
    expect(reload.supersededBy).toBe(successor.id);
    expect((await post(`${k.root}/${old.id}/supersede`, k.supersede.again)).status).toBe(409);
  });
});
