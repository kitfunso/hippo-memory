// Route rules every typed object shares over HTTP, one table row per kind; a rule only one kind has stays in its
// http-<kind> test. One server serves the whole file, so the request limits are off and every test makes its own rows.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { JsonValue } from '../../src/util/json.js';
import { makeRoot } from '../_helpers/make-root.js';

type Body = { [key: string]: JsonValue };

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

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
let apiKeyB: CreateApiKeyResult;

beforeAll(async () => {
  home = makeRoot('http-objects');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-objects', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-objects-b', role: 'admin' });
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: home, port: 0, rateLimits: { perCaller: 'off', perAddress: 'off' } });
});

afterAll(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every response here comes from a typed-object route under test, whose envelope is { <field>: row } or
  // { <listField>: row[] }; the assertions after each call pin the fields read.
  return (await res.json()) as T;
}

function post(path: string, body?: Body, key: CreateApiKeyResult = apiKey): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method: 'POST',
    headers: authHeaders(key),
    body: body && JSON.stringify(body),
  });
}

function get(path: string, key: CreateApiKeyResult = apiKey): Promise<Response> {
  return fetch(`${handle.url}${path}`, { headers: authHeaders(key) });
}

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

type Reply = readonly [
  name: string,
  method: string,
  path: string,
  body: Body | undefined,
  status: number,
  error: string,
];

const over = (cap: number): string => 'x'.repeat(cap + 1);
const at = (cap: number): string => 'x'.repeat(cap);
const BAD_STATUS = 'status must be one of: active | superseded | closed | all (got "retired")';
const SHORT = 'Memory content too short (0 chars, minimum 3): ""';

const DEC = '/v1/decisions';
const DEC_MISSING = '/v1/decisions/99999/supersede';
const DEC_NO_TARGET = 'saveDecision: decision 99999 to supersede not found for tenant default';
// Each row also sends every later field invalid, and every superseded id is missing,
// so a row pins which check answers first as well as the reply text.
const DECISION_REPLIES: readonly Reply[] = [
  ['list: an unknown status', 'GET', `${DEC}?status=retired`, undefined, 400, BAD_STATUS],
  [
    'create: empty text',
    'POST',
    DEC,
    { text: '', context: 7, supersedesDecisionId: 0 },
    400,
    'text is required (non-empty string)',
  ],
  [
    'create: text over the cap',
    'POST',
    DEC,
    { text: over(4096), context: 7, supersedesDecisionId: 0 },
    400,
    'text exceeds 4096-character cap',
  ],
  [
    'create: context not a string',
    'POST',
    DEC,
    { text: 't', context: 7, supersedesDecisionId: 0 },
    400,
    'context must be a string',
  ],
  [
    'create: context over the cap',
    'POST',
    DEC,
    { text: 't', context: over(4096), supersedesDecisionId: 0 },
    400,
    'context exceeds 4096-character cap',
  ],
  [
    'create: supersedesDecisionId of zero',
    'POST',
    DEC,
    { text: 't', supersedesDecisionId: 0 },
    400,
    'supersedesDecisionId must be a positive integer',
  ],
  [
    'create: a fractional supersedesDecisionId',
    'POST',
    DEC,
    { text: 't', supersedesDecisionId: 1.5 },
    400,
    'supersedesDecisionId must be a positive integer',
  ],
  [
    'create: every field at its cap reaches the store',
    'POST',
    DEC,
    { text: at(4096), context: at(4096), supersedesDecisionId: 99999 },
    409,
    DEC_NO_TARGET,
  ],
  [
    'create: a null context reaches the store',
    'POST',
    DEC,
    { text: 'ttt', context: null, supersedesDecisionId: 99999 },
    409,
    DEC_NO_TARGET,
  ],
  ['create: spaces-only text passes the route check', 'POST', DEC, { text: '  ' }, 400, SHORT],
  ['supersede: empty text', 'POST', DEC_MISSING, { text: '', context: 7 }, 400, 'text is required (non-empty string)'],
  [
    'supersede: text over the cap',
    'POST',
    DEC_MISSING,
    { text: over(4096), context: 7 },
    400,
    'text exceeds 4096-character cap',
  ],
  ['supersede: context not a string', 'POST', DEC_MISSING, { text: 't', context: 7 }, 400, 'context must be a string'],
  [
    'supersede: context over the cap',
    'POST',
    DEC_MISSING,
    { text: 't', context: over(4096) },
    400,
    'context exceeds 4096-character cap',
  ],
  [
    'supersede: every field at its cap reaches the store',
    'POST',
    DEC_MISSING,
    { text: at(4096), context: at(4096) },
    404,
    DEC_NO_TARGET,
  ],
  [
    'supersede: a null context reaches the store',
    'POST',
    DEC_MISSING,
    { text: 'ttt', context: null },
    404,
    DEC_NO_TARGET,
  ],
  ['supersede: spaces-only text passes the route check', 'POST', DEC_MISSING, { text: '  ' }, 400, SHORT],
];

const NOTE = '/v1/customer-notes';
const NOTE_MISSING = '/v1/customer-notes/99999/supersede';
// Each row also sends every later field invalid, and the supersede target does not exist,
// so a row pins which check answers first as well as the reply text.
const NOTE_REPLIES: readonly Reply[] = [
  ['list: an unknown status', 'GET', `${NOTE}?status=retired`, undefined, 400, BAD_STATUS],
  ['create: blank customer', 'POST', NOTE, { customer: '  ', note: 7 }, 400, 'customer is required (non-empty string)'],
  [
    'create: customer over the cap',
    'POST',
    NOTE,
    { customer: over(256), note: 7 },
    400,
    'customer exceeds 256-character cap',
  ],
  ['create: blank note', 'POST', NOTE, { customer: 'c', note: '  ' }, 400, 'note is required (non-empty string)'],
  [
    'create: note over the cap',
    'POST',
    NOTE,
    { customer: 'c', note: over(8192) },
    400,
    'note exceeds 8192-character cap',
  ],
  [
    'supersede: blank note',
    'POST',
    NOTE_MISSING,
    { note: '  ', changeSummary: 7 },
    400,
    'note is required (non-empty string)',
  ],
  [
    'supersede: note over the cap',
    'POST',
    NOTE_MISSING,
    { note: over(8192), changeSummary: 7 },
    400,
    'note exceeds 8192-character cap',
  ],
  [
    'supersede: changeSummary not a string',
    'POST',
    NOTE_MISSING,
    { note: 'n', changeSummary: 7 },
    400,
    'changeSummary must be a string',
  ],
  [
    'supersede: changeSummary over the cap',
    'POST',
    NOTE_MISSING,
    { note: 'n', changeSummary: over(4096) },
    400,
    'changeSummary exceeds 4096-character cap',
  ],
  [
    'supersede: every field at its cap reaches the lookup',
    'POST',
    NOTE_MISSING,
    { note: at(8192), changeSummary: at(4096) },
    404,
    'customer note 99999 not found',
  ],
  [
    'supersede: a null changeSummary reaches the lookup',
    'POST',
    NOTE_MISSING,
    { note: 'n', changeSummary: null },
    404,
    'customer note 99999 not found',
  ],
];

const INC = '/v1/incidents';
const INC_MISSING = '/v1/incidents/99999/resolve';
const INC_NO_MEMORY = 'saveIncident: linked memory mem_missing not found for tenant default';
// Each row also sends every later field invalid, and every linked memory or resolved id is missing,
// so a row pins which check answers first as well as the reply text.
const INCIDENT_REPLIES: readonly Reply[] = [
  [
    'list: an unknown status',
    'GET',
    `${INC}?status=retired`,
    undefined,
    400,
    'status must be one of: open | resolved | closed | all (got "retired")',
  ],
  [
    'create: empty text',
    'POST',
    INC,
    { text: '', context: 7, linkedMemoryIds: 7 },
    400,
    'text is required (non-empty string)',
  ],
  [
    'create: text over the cap',
    'POST',
    INC,
    { text: over(4096), context: 7, linkedMemoryIds: 7 },
    400,
    'text exceeds 4096-character cap',
  ],
  [
    'create: context not a string',
    'POST',
    INC,
    { text: 't', context: 7, linkedMemoryIds: 7 },
    400,
    'context must be a string',
  ],
  [
    'create: context over the cap',
    'POST',
    INC,
    { text: 't', context: over(4096), linkedMemoryIds: 7 },
    400,
    'context exceeds 4096-character cap',
  ],
  [
    'create: linkedMemoryIds not an array',
    'POST',
    INC,
    { text: 't', linkedMemoryIds: 7 },
    400,
    'linkedMemoryIds must be an array of memory ids',
  ],
  [
    'create: too many linkedMemoryIds',
    'POST',
    INC,
    { text: 't', linkedMemoryIds: Array.from({ length: 257 }, () => '') },
    400,
    'linkedMemoryIds exceeds 256-item cap',
  ],
  [
    'create: an empty linkedMemoryIds entry',
    'POST',
    INC,
    { text: 't', linkedMemoryIds: [''] },
    400,
    'each linkedMemoryIds entry must be a non-empty string <= 4096 chars',
  ],
  [
    'create: every field at its cap reaches the store',
    'POST',
    INC,
    { text: at(4096), context: at(4096), linkedMemoryIds: ['mem_missing'] },
    409,
    INC_NO_MEMORY,
  ],
  [
    'create: a null context reaches the store',
    'POST',
    INC,
    { text: 'ttt', context: null, linkedMemoryIds: ['mem_missing'] },
    409,
    INC_NO_MEMORY,
  ],
  ['create: spaces-only text passes the route check', 'POST', INC, { text: '  ' }, 400, SHORT],
  ['resolve: no resolutionText', 'POST', INC_MISSING, {}, 400, 'resolutionText is required (non-empty string)'],
  [
    'resolve: blank resolutionText',
    'POST',
    INC_MISSING,
    { resolutionText: '  ' },
    400,
    'resolutionText is required (non-empty string)',
  ],
  [
    'resolve: resolutionText over the cap',
    'POST',
    INC_MISSING,
    { resolutionText: over(4096) },
    400,
    'resolutionText exceeds 4096-character cap',
  ],
  [
    'resolve: resolutionText at its cap reaches the store',
    'POST',
    INC_MISSING,
    { resolutionText: at(4096) },
    404,
    'resolveIncident: incident 99999 not found for tenant default',
  ],
];

const POL = '/v1/policies';
const POL_MISSING = '/v1/policies/99999/supersede';
// Each row also sends every later field invalid, and the supersede target does not exist,
// so a row pins which check answers first as well as the reply text.
const POLICY_REPLIES: readonly Reply[] = [
  ['list: an unknown status', 'GET', `${POL}?status=retired`, undefined, 400, BAD_STATUS],
  [
    'create: blank policyName',
    'POST',
    POL,
    { policyName: '  ', policyText: 7, validFrom: 7, validTo: 7 },
    400,
    'policyName is required (non-empty string)',
  ],
  [
    'create: policyName over the cap',
    'POST',
    POL,
    { policyName: over(4096), policyText: 7, validFrom: 7, validTo: 7 },
    400,
    'policyName exceeds 4096-character cap',
  ],
  [
    'create: blank policyText',
    'POST',
    POL,
    { policyName: 'p', policyText: '  ', validFrom: 7, validTo: 7 },
    400,
    'policyText is required (non-empty string)',
  ],
  [
    'create: policyText over the cap',
    'POST',
    POL,
    { policyName: 'p', policyText: over(4096), validFrom: 7, validTo: 7 },
    400,
    'policyText exceeds 4096-character cap',
  ],
  [
    'create: validFrom not a string',
    'POST',
    POL,
    { policyName: 'p', policyText: 't', validFrom: 7, validTo: 7 },
    400,
    'validFrom must be a string',
  ],
  [
    'create: validFrom over the cap',
    'POST',
    POL,
    { policyName: 'p', policyText: 't', validFrom: over(64), validTo: 7 },
    400,
    'validFrom exceeds 64-character cap',
  ],
  [
    'create: validTo not a string',
    'POST',
    POL,
    { policyName: 'p', policyText: 't', validTo: 7 },
    400,
    'validTo must be a string',
  ],
  [
    'create: validTo over the cap',
    'POST',
    POL,
    { policyName: 'p', policyText: 't', validTo: over(64) },
    400,
    'validTo exceeds 64-character cap',
  ],
  [
    'supersede: blank policyText',
    'POST',
    POL_MISSING,
    { policyText: '  ', validFrom: 7, validTo: 7, changeSummary: 7 },
    400,
    'policyText is required (non-empty string)',
  ],
  [
    'supersede: policyText over the cap',
    'POST',
    POL_MISSING,
    { policyText: over(4096), validFrom: 7, validTo: 7, changeSummary: 7 },
    400,
    'policyText exceeds 4096-character cap',
  ],
  [
    'supersede: validFrom not a string',
    'POST',
    POL_MISSING,
    { policyText: 't', validFrom: 7, validTo: 7, changeSummary: 7 },
    400,
    'validFrom must be a string',
  ],
  [
    'supersede: validFrom over the cap',
    'POST',
    POL_MISSING,
    { policyText: 't', validFrom: over(64), validTo: 7, changeSummary: 7 },
    400,
    'validFrom exceeds 64-character cap',
  ],
  [
    'supersede: validTo not a string',
    'POST',
    POL_MISSING,
    { policyText: 't', validTo: 7, changeSummary: 7 },
    400,
    'validTo must be a string',
  ],
  [
    'supersede: validTo over the cap',
    'POST',
    POL_MISSING,
    { policyText: 't', validTo: over(64), changeSummary: 7 },
    400,
    'validTo exceeds 64-character cap',
  ],
  [
    'supersede: changeSummary not a string',
    'POST',
    POL_MISSING,
    { policyText: 't', changeSummary: 7 },
    400,
    'changeSummary must be a string',
  ],
  [
    'supersede: changeSummary over the cap',
    'POST',
    POL_MISSING,
    { policyText: 't', changeSummary: over(4096) },
    400,
    'changeSummary exceeds 4096-character cap',
  ],
  [
    'supersede: every field at its cap reaches the lookup',
    'POST',
    POL_MISSING,
    { policyText: at(4096), validFrom: at(64), validTo: at(64), changeSummary: at(4096) },
    404,
    'policy 99999 not found',
  ],
  [
    'supersede: null optional fields reach the lookup',
    'POST',
    POL_MISSING,
    { policyText: 't', validFrom: null, validTo: null, changeSummary: null },
    404,
    'policy 99999 not found',
  ],
];

const PROC = '/v1/processes';
const PROC_MISSING = '/v1/processes/99999/supersede';
// Each row also sends every later field invalid, and the supersede target does not exist,
// so a row pins which check answers first as well as the reply text.
const PROCESS_REPLIES: readonly Reply[] = [
  ['list: an unknown status', 'GET', `${PROC}?status=retired`, undefined, 400, BAD_STATUS],
  [
    'create: blank processName',
    'POST',
    PROC,
    { processName: '  ', steps: 7, description: 7 },
    400,
    'processName is required (non-empty string)',
  ],
  [
    'create: processName over the cap',
    'POST',
    PROC,
    { processName: over(4096), steps: 7, description: 7 },
    400,
    'processName exceeds 4096-character cap',
  ],
  [
    'create: steps not an array',
    'POST',
    PROC,
    { processName: 'p', steps: 7, description: 7 },
    400,
    'steps must be an array of strings',
  ],
  [
    'create: too many steps',
    'POST',
    PROC,
    { processName: 'p', steps: Array.from({ length: 201 }, () => 7), description: 7 },
    400,
    'steps exceeds 200-step cap',
  ],
  [
    'create: description not a string',
    'POST',
    PROC,
    { processName: 'p', steps: ['a'], description: 7 },
    400,
    'description must be a string',
  ],
  [
    'create: description over the cap',
    'POST',
    PROC,
    { processName: 'p', steps: ['a'], description: over(4096) },
    400,
    'description exceeds 4096-character cap',
  ],
  [
    'supersede: steps not an array',
    'POST',
    PROC_MISSING,
    { steps: 7, changeSummary: 7, description: 7 },
    400,
    'steps must be an array of strings',
  ],
  [
    'supersede: no steps',
    'POST',
    PROC_MISSING,
    { steps: [], changeSummary: 7, description: 7 },
    400,
    'steps is required (at least one step) for a supersession',
  ],
  [
    'supersede: changeSummary not a string',
    'POST',
    PROC_MISSING,
    { steps: ['a'], changeSummary: 7, description: 7 },
    400,
    'changeSummary must be a string',
  ],
  [
    'supersede: changeSummary over the cap',
    'POST',
    PROC_MISSING,
    { steps: ['a'], changeSummary: over(4096), description: 7 },
    400,
    'changeSummary exceeds 4096-character cap',
  ],
  [
    'supersede: description not a string',
    'POST',
    PROC_MISSING,
    { steps: ['a'], description: 7 },
    400,
    'description must be a string',
  ],
  [
    'supersede: description over the cap',
    'POST',
    PROC_MISSING,
    { steps: ['a'], description: over(4096) },
    400,
    'description exceeds 4096-character cap',
  ],
  [
    'supersede: every field at its cap reaches the lookup',
    'POST',
    PROC_MISSING,
    { steps: ['a'], changeSummary: at(4096), description: at(4096) },
    404,
    'process 99999 not found',
  ],
  [
    'supersede: null optional fields reach the lookup',
    'POST',
    PROC_MISSING,
    { steps: ['a'], changeSummary: null, description: null },
    404,
    'process 99999 not found',
  ],
];

const BRIEF = '/v1/project-briefs';
const BRIEF_REFRESH = '/v1/project-briefs/refresh';
const BRIEF_MISSING = '/v1/project-briefs/99999/supersede';
// Each row also sends every later field invalid, and the supersede target does not exist,
// so a row pins which check answers first as well as the reply text.
const BRIEF_REPLIES: readonly Reply[] = [
  ['list: an unknown status', 'GET', `${BRIEF}?status=retired`, undefined, 400, BAD_STATUS],
  ['create: blank repo', 'POST', BRIEF, { repo: '  ', summary: 7 }, 400, 'repo is required (non-empty string)'],
  ['create: repo over the cap', 'POST', BRIEF, { repo: over(256), summary: 7 }, 400, 'repo exceeds 256-character cap'],
  ['create: blank summary', 'POST', BRIEF, { repo: 'r', summary: '  ' }, 400, 'summary is required (non-empty string)'],
  [
    'create: summary over the cap',
    'POST',
    BRIEF,
    { repo: 'r', summary: over(8192) },
    400,
    'summary exceeds 8192-character cap',
  ],
  [
    'refresh: blank repo',
    'POST',
    BRIEF_REFRESH,
    { repo: '  ', dryRun: true },
    400,
    'repo is required (non-empty string)',
  ],
  [
    'refresh: repo over the cap',
    'POST',
    BRIEF_REFRESH,
    { repo: over(256), dryRun: true },
    400,
    'repo exceeds 256-character cap',
  ],
  [
    'supersede: blank summary',
    'POST',
    BRIEF_MISSING,
    { summary: '  ', changeSummary: 7 },
    400,
    'summary is required (non-empty string)',
  ],
  [
    'supersede: summary over the cap',
    'POST',
    BRIEF_MISSING,
    { summary: over(8192), changeSummary: 7 },
    400,
    'summary exceeds 8192-character cap',
  ],
  [
    'supersede: changeSummary not a string',
    'POST',
    BRIEF_MISSING,
    { summary: 's', changeSummary: 7 },
    400,
    'changeSummary must be a string',
  ],
  [
    'supersede: changeSummary over the cap',
    'POST',
    BRIEF_MISSING,
    { summary: 's', changeSummary: over(4096) },
    400,
    'changeSummary exceeds 4096-character cap',
  ],
  [
    'supersede: every field at its cap reaches the lookup',
    'POST',
    BRIEF_MISSING,
    { summary: at(8192), changeSummary: at(4096) },
    404,
    'project brief 99999 not found',
  ],
  [
    'supersede: a null changeSummary reaches the lookup',
    'POST',
    BRIEF_MISSING,
    { summary: 's', changeSummary: null },
    404,
    'project brief 99999 not found',
  ],
];

const SKILL = '/v1/skills';
const SKILL_MISSING = '/v1/skills/99999/supersede';
// Each row also sends every later field invalid, and the supersede target does not exist,
// so a row pins which check answers first as well as the reply text.
const SKILL_REPLIES: readonly Reply[] = [
  ['list: an unknown status', 'GET', `${SKILL}?status=retired`, undefined, 400, BAD_STATUS],
  [
    'create: blank skillName',
    'POST',
    SKILL,
    { skillName: '  ', instructions: 7, trigger: 7 },
    400,
    'skillName is required (non-empty string)',
  ],
  [
    'create: skillName over the cap',
    'POST',
    SKILL,
    { skillName: over(256), instructions: 7, trigger: 7 },
    400,
    'skillName exceeds 256-character cap',
  ],
  [
    'create: blank instructions',
    'POST',
    SKILL,
    { skillName: 's', instructions: '  ', trigger: 7 },
    400,
    'instructions are required (non-empty string)',
  ],
  [
    'create: instructions over the cap',
    'POST',
    SKILL,
    { skillName: 's', instructions: over(8192), trigger: 7 },
    400,
    'instructions exceed 8192-character cap',
  ],
  [
    'create: trigger not a string',
    'POST',
    SKILL,
    { skillName: 's', instructions: 'i', trigger: 7 },
    400,
    'trigger must be a string',
  ],
  [
    'create: trigger over the cap',
    'POST',
    SKILL,
    { skillName: 's', instructions: 'i', trigger: over(1024) },
    400,
    'trigger exceeds 1024-character cap',
  ],
  [
    'supersede: blank instructions',
    'POST',
    SKILL_MISSING,
    { instructions: '  ', trigger: 7, changeSummary: 7 },
    400,
    'instructions are required (non-empty string)',
  ],
  [
    'supersede: instructions over the cap',
    'POST',
    SKILL_MISSING,
    { instructions: over(8192), trigger: 7, changeSummary: 7 },
    400,
    'instructions exceed 8192-character cap',
  ],
  [
    'supersede: trigger not a string',
    'POST',
    SKILL_MISSING,
    { instructions: 'i', trigger: 7, changeSummary: 7 },
    400,
    'trigger must be a string',
  ],
  [
    'supersede: trigger over the cap',
    'POST',
    SKILL_MISSING,
    { instructions: 'i', trigger: over(1024), changeSummary: 7 },
    400,
    'trigger exceeds 1024-character cap',
  ],
  [
    'supersede: changeSummary not a string',
    'POST',
    SKILL_MISSING,
    { instructions: 'i', changeSummary: 7 },
    400,
    'changeSummary must be a string',
  ],
  [
    'supersede: changeSummary over the cap',
    'POST',
    SKILL_MISSING,
    { instructions: 'i', changeSummary: over(4096) },
    400,
    'changeSummary exceeds 4096-character cap',
  ],
  [
    'supersede: every field at its cap reaches the lookup',
    'POST',
    SKILL_MISSING,
    { instructions: at(8192), trigger: at(1024), changeSummary: at(4096) },
    404,
    'skill 99999 not found',
  ],
  [
    'supersede: null optional fields reach the lookup',
    'POST',
    SKILL_MISSING,
    { instructions: 'i', trigger: null, changeSummary: null },
    404,
    'skill 99999 not found',
  ],
];

function named(kind: string, rows: readonly Reply[]): Reply[] {
  return rows.map(([name, method, path, body, status, error]) => [
    `${kind} ${name}`,
    method,
    path,
    body,
    status,
    error,
  ]);
}

const REPLIES: readonly Reply[] = [
  ...named('decision', DECISION_REPLIES),
  ...named('customer note', NOTE_REPLIES),
  ...named('incident', INCIDENT_REPLIES),
  ...named('policy', POLICY_REPLIES),
  ...named('process', PROCESS_REPLIES),
  ...named('project brief', BRIEF_REPLIES),
  ...named('skill', SKILL_REPLIES),
];

describe('HTTP typed-object replies', () => {
  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
