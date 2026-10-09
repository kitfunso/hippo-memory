/** Keyset cursor paging on the /v1 list routes, against a real SQLite store and a real server: no mocks. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, listApiKeys, type CreateApiKeyResult } from '../src/store/auth.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { recordQuarantine } from '../src/store/quarantine.js';
import * as api from '../src/api.js';
import { loadDecisions, saveDecision } from '../src/decisions.js';
import { loadIncidents, saveIncident } from '../src/incidents.js';
import { loadProcesses, saveProcess } from '../src/processes.js';
import { loadPolicies, savePolicy } from '../src/policies.js';
import { loadSkills, saveSkill } from '../src/skills.js';
import { loadProjectBriefs, saveProjectBrief } from '../src/project-briefs.js';
import { loadCustomerNotes, saveCustomerNote } from '../src/customer-notes.js';
import { loadAllPredictions, savePrediction } from '../src/store/predictions.js';
import { makeRoot } from './_helpers/make-root.js';
import { type JsonValue, isJsonString, isJsonObject } from '../src/json.js';

const ROWS = 7;
const PAGE = 3;

interface ListRoute {
  path: string;
  /** Body key holding the list; null for routes whose body is a bare array (cursor rides X-Next-Cursor). */
  key: string | null;
}

const ROUTES: readonly ListRoute[] = [
  { path: '/v1/auth/keys', key: null },
  { path: '/v1/quarantine', key: 'quarantine' },
  { path: '/v1/audit', key: null },
  { path: '/v1/predictions', key: 'predictions' },
  { path: '/v1/decisions', key: 'decisions' },
  { path: '/v1/incidents', key: 'incidents' },
  { path: '/v1/processes', key: 'processes' },
  { path: '/v1/policies', key: 'policies' },
  { path: '/v1/skills', key: 'skills' },
  { path: '/v1/project-briefs', key: 'briefs' },
  { path: '/v1/customer-notes', key: 'notes' },
];

let home: string;
let handle: ServerHandle;
let adminKey: CreateApiKeyResult;

function seedTenant(tenantId: string, count: number): void {
  const ctx: api.HippoDbContext = { hippoRoot: home, tenantId, actor: api.adminActor('test') };
  for (let i = 0; i < count; i++) {
    saveDecision(home, tenantId, { decisionText: `${tenantId} decision ${i}` });
    saveIncident(home, tenantId, { incidentText: `${tenantId} incident ${i}` });
    saveProcess(home, tenantId, { processName: `${tenantId} process ${i}`, steps: ['one', 'two'] });
    savePolicy(home, tenantId, { policyName: `${tenantId} policy ${i}`, policyText: 'keep it short' });
    saveSkill(home, tenantId, { skillName: `${tenantId} skill ${i}`, instructions: 'do the thing' });
    saveProjectBrief(home, tenantId, { repo: `${tenantId}/repo-${i}`, summary: 'a brief' });
    saveCustomerNote(home, tenantId, { customer: `${tenantId} customer ${i}`, note: 'a note' });
    savePrediction(home, tenantId, { classTag: 'paging', claimText: `${tenantId} claim ${i}` });
    const { id } = api.remember(ctx, { content: `${tenantId} held memory ${i} for review` });
    const db = openHippoDb(home);
    try {
      createApiKey(db, { tenantId, label: `${tenantId} key ${i}`, role: 'member' });
      recordQuarantine(db, { tenantId, memoryId: id, originalScope: null, reason: 'test', actor: 'test' });
    } finally {
      closeHippoDb(db);
    }
  }
}

beforeAll(async () => {
  home = makeRoot('list-paging');
  const db = openHippoDb(home);
  try {
    adminKey = createApiKey(db, { tenantId: 'default', label: 'paging admin', role: 'admin' });
  } finally {
    closeHippoDb(db);
  }
  seedTenant('default', ROWS);
  // Another tenant's rows must never leak into a page, even when the tenant filter sits beside a cursor.
  seedTenant('tenant-b', 3);
  // Paging every route makes well over the per-IP burst; the limiter is read once, at serve().
  vi.stubEnv('HIPPO_V1_RPS', '0');
  handle = await serve({ hippoRoot: home, port: 0 });
  vi.unstubAllEnvs();
}, 60_000);

afterAll(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

interface Page {
  status: number;
  body: JsonValue;
  items: JsonValue[];
  next: string | null;
}

async function getPage(route: ListRoute, params: Record<string, string> = {}): Promise<Page> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${handle.url}${route.path}${qs ? `?${qs}` : ''}`, {
    headers: { authorization: `Bearer ${adminKey.plaintext}` },
  });
  const body: JsonValue = await res.json();
  if (route.key === null) {
    return { status: res.status, body, items: Array.isArray(body) ? body : [], next: res.headers.get('x-next-cursor') };
  }
  const record: Record<string, JsonValue> = isJsonObject(body) ? body : {};
  const list = record[route.key];
  const next = record['next_cursor'];
  return { status: res.status, body, items: Array.isArray(list) ? list : [], next: isJsonString(next) ? next : null };
}

async function pageThrough(route: ListRoute, limit: number): Promise<JsonValue[][]> {
  const pages: JsonValue[][] = [];
  let cursor: string | null = null;
  do {
    const page = await getPage(route, cursor === null ? { limit: String(limit) } : { limit: String(limit), cursor });
    expect(page.status).toBe(200);
    pages.push(page.items);
    cursor = page.next;
  } while (cursor !== null && pages.length < 100);
  return pages;
}

describe.each(ROUTES)('GET $path paging', (route) => {
  it('pages of 3 return every row exactly once, in the single-request order', async () => {
    const whole = await getPage(route, { limit: '1000' });
    expect(whole.status).toBe(200);
    expect(whole.next).toBeNull();
    expect(whole.items.length).toBeGreaterThanOrEqual(ROWS);

    const pages = await pageThrough(route, PAGE);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const page of pages.slice(0, -1)) expect(page).toHaveLength(PAGE);
    expect(pages.flat()).toEqual(whole.items);
    const ids = pages.flat().map((item) => JSON.stringify(item));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a malformed cursor is a 400 in the shared {error} shape', async () => {
    const objectCursor = Buffer.from(JSON.stringify({ a: 1 })).toString('base64url');
    for (const cursor of ['not a cursor!', objectCursor, Buffer.from('[1]').toString('base64url'), '']) {
      const page = await getPage(route, { cursor });
      expect(page.status).toBe(400);
      expect(Object.keys(page.body ?? {})).toEqual(['error']);
    }
  });
});

describe('no paging params: the body a small store got before cursors existed', () => {
  const ctx = (): api.HippoDbContext => ({ hippoRoot: home, tenantId: 'default', actor: api.adminActor('test') });
  const json = <T>(value: T): JsonValue => JSON.parse(JSON.stringify(value));

  // Each reference is the store call the route made before paging, with the same arguments.
  const before = new Map<string, () => JsonValue | Promise<JsonValue>>([
    ['/v1/quarantine', async () => json(await api.quarantineList(ctx(), { status: 'pending' }))],
    ['/v1/predictions', () => json(loadAllPredictions(home, 'default', { limit: 100 }))],
    ['/v1/decisions', () => json(loadDecisions(home, 'default', { limit: 100 }))],
    ['/v1/incidents', () => json(loadIncidents(home, 'default', { limit: 100 }))],
    ['/v1/processes', () => json(loadProcesses(home, 'default', { limit: 100 }))],
    ['/v1/policies', () => json(loadPolicies(home, 'default', { limit: 100 }))],
    ['/v1/skills', () => json(loadSkills(home, 'default', { limit: 100 }))],
    ['/v1/project-briefs', () => json(loadProjectBriefs(home, 'default', { limit: 100 }))],
    ['/v1/customer-notes', () => json(loadCustomerNotes(home, 'default', { limit: 100 }))],
  ]);

  it.each(ROUTES.filter((r) => r.key !== null))('$path keeps its list and adds next_cursor: null last', async (route) => {
    const page = await getPage(route);
    expect(page.status).toBe(200);
    expect(Object.keys(page.body ?? {})).toEqual([route.key, 'next_cursor']);
    expect(page.next).toBeNull();
    expect(page.items).toEqual(await before.get(route.path)!());
  });

  it('/v1/auth/keys returns the same bare array, with no next-page header', async () => {
    const db = openHippoDb(home);
    let expected: JsonValue;
    try {
      expected = json(listApiKeys(db, { active: true }).filter((k) => k.tenantId === 'default'));
    } finally {
      closeHippoDb(db);
    }
    const page = await getPage(ROUTES[0]!);
    expect(page.status).toBe(200);
    expect(page.body).toEqual(expected);
    expect(page.next).toBeNull();
  });

  it('/v1/audit returns the same bare array', async () => {
    const page = await getPage(ROUTES[2]!);
    const db = openHippoDb(home);
    try {
      expect(page.body).toEqual(json(queryAuditEvents(db, { tenantId: 'default' })));
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('rows that share a sort key', () => {
  it('tie-break on id, so a page boundary inside a tie skips and repeats nothing', async () => {
    const db = openHippoDb(home);
    try {
      // The test is about SQL ordering, so it pins the timestamps with SQL.
      db.prepare(`UPDATE decisions SET created_at = '2026-01-01T00:00:00.000Z' WHERE tenant_id = 'default'`).run();
      db.prepare(`UPDATE memory_quarantine SET quarantined_at = '2026-01-01T00:00:00.000Z' WHERE tenant_id = 'default'`).run();
    } finally {
      closeHippoDb(db);
    }
    for (const route of [ROUTES[4]!, ROUTES[1]!]) {
      const whole = await getPage(route, { limit: '1000' });
      const pages = await pageThrough(route, 2);
      expect(pages.length).toBeGreaterThanOrEqual(4);
      expect(pages.flat()).toEqual(whole.items);
    }
  });
});

describe('limit on the routes that had none', () => {
  it.each(['/v1/auth/keys', '/v1/quarantine'])('%s rejects a bad limit with a 400', async (path) => {
    for (const limit of ['0', '1.5', '1001', 'abc']) {
      const page = await getPage({ path, key: null }, { limit });
      expect(page.status).toBe(400);
    }
  });
});
