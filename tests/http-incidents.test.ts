/**
 * E2 incident first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-29-e2-incident-object.md
 *
 * Covers:
 * 1. POST /v1/incidents creates a row (201 + Incident body)
 * 2. GET /v1/incidents lists + status filter
 * 3. GET /v1/incidents/:id returns single + 404 on missing
 * 4. POST /v1/incidents/:id/resolve resolves open (+409 on re-resolve)
 * 5. POST /v1/incidents/:id/close retires (+409 on re-close)
 * 6. Bearer auth required (no Authorization -> 401)
 * 7. status filter validation (invalid -> 400)
 * 8. cross-tenant isolation
 * 9. DoS cap on text length (400)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreatedApiKey } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import type { Incident } from '../src/incidents.js';

/** Parse a fetch Response body against a caller-declared shape. */
async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: only used against this file's own /v1/incidents route responses,
  // whose JSON shape is fixed by the handler in src/server.ts and checked by
  // the assertions immediately following each call site.
  return (await res.json()) as T;
}

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-inc-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreatedApiKey;
let apiKeyB: CreatedApiKey;

beforeEach(async () => {
  home = makeRoot();
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-inc', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-inc-b', role: 'admin' });
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

function authHeaders(key: CreatedApiKey = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}

async function createIncident(
  text: string,
  extra: { context?: string; linkedMemoryIds?: string[] } = {},
  key: CreatedApiKey = apiKey,
) {
  return fetch(`${handle.url}/v1/incidents`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ text, ...extra }),
  });
}

describe('HTTP /v1/incidents (E2 incident first-class object)', () => {
  it('POST /v1/incidents creates an incident (201 + Incident body)', async () => {
    const res = await createIncident('DB pool exhausted', { context: 'spike at 14:00' });
    expect(res.status).toBe(201);
    const body = await jsonAs<{ incident: Incident }>(res);
    expect(body.incident.incidentText).toBe('DB pool exhausted');
    expect(body.incident.context).toBe('spike at 14:00');
    expect(body.incident.status).toBe('open');
    expect(body.incident.id).toBeGreaterThan(0);
    expect(body.incident.linkedMemoryIds).toEqual([]);
  });

  it('GET /v1/incidents lists and filters by status', async () => {
    await createIncident('open one');
    const toClose = (await jsonAs<{ incident: Incident }>(await createIncident('to close'))).incident;
    await fetch(`${handle.url}/v1/incidents/${toClose.id}/close`, { method: 'POST', headers: authHeaders() });

    const allRes = await fetch(`${handle.url}/v1/incidents`, { headers: authHeaders() });
    expect(allRes.status).toBe(200);
    const all = await jsonAs<{ incidents: Incident[] }>(allRes);
    expect(all.incidents.length).toBe(2);

    const openRes = await fetch(`${handle.url}/v1/incidents?status=open`, { headers: authHeaders() });
    const open = await jsonAs<{ incidents: Incident[] }>(openRes);
    expect(open.incidents.length).toBe(1);
    expect(open.incidents[0].status).toBe('open');
  });

  it('GET /v1/incidents/:id returns single + 404 on missing', async () => {
    const created = (await jsonAs<{ incident: Incident }>(await createIncident('show me'))).incident;
    const getRes = await fetch(`${handle.url}/v1/incidents/${created.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(200);
    expect((await jsonAs<{ incident: Incident }>(getRes)).incident.id).toBe(created.id);

    const missing = await fetch(`${handle.url}/v1/incidents/99999`, { headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

  it('POST /v1/incidents/:id/resolve resolves an open incident (+409 on re-resolve)', async () => {
    const inc = (await jsonAs<{ incident: Incident }>(await createIncident('API 500s'))).incident;
    const resRes = await fetch(`${handle.url}/v1/incidents/${inc.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ resolutionText: 'restarted workers' }),
    });
    expect(resRes.status).toBe(200);
    const resolved = (await jsonAs<{ incident: Incident }>(resRes)).incident;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionText).toBe('restarted workers');

    // re-resolving the already-resolved incident -> 409
    const conflict = await fetch(`${handle.url}/v1/incidents/${inc.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ resolutionText: 'again' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('resolve requires resolutionText (missing -> 400)', async () => {
    const inc = (await jsonAs<{ incident: Incident }>(await createIncident('needs resolution'))).incident;
    const res = await fetch(`${handle.url}/v1/incidents/${inc.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/incidents/:id/close retires an incident (+409 on re-close)', async () => {
    const inc = (await jsonAs<{ incident: Incident }>(await createIncident('close me'))).incident;
    const closeRes = await fetch(`${handle.url}/v1/incidents/${inc.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(closeRes.status).toBe(200);
    expect((await jsonAs<{ incident: Incident }>(closeRes)).incident.status).toBe('closed');

    const recl = await fetch(`${handle.url}/v1/incidents/${inc.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(recl.status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'no auth attempt' }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.HIPPO_REQUIRE_AUTH;
      else process.env.HIPPO_REQUIRE_AUTH = prev;
    }
  });

  it('status filter validation (invalid -> 400)', async () => {
    const res = await fetch(`${handle.url}/v1/incidents?status=retired`, { headers: authHeaders() });
    expect(res.status).toBe(400);
  });

  it('cross-tenant isolation: tenant-b cannot see default-tenant incidents', async () => {
    const created = (await jsonAs<{ incident: Incident }>(await createIncident('default secret'))).incident;
    const bList = await jsonAs<{ incidents: Incident[] }>(
      await fetch(`${handle.url}/v1/incidents`, { headers: authHeaders(apiKeyB) }),
    );
    expect(bList.incidents.length).toBe(0);
    const bGet = await fetch(`${handle.url}/v1/incidents/${created.id}`, { headers: authHeaders(apiKeyB) });
    expect(bGet.status).toBe(404);
  });

  it('DoS cap: text over 4096 chars -> 400', async () => {
    const res = await createIncident('x'.repeat(4097));
    expect(res.status).toBe(400);
  });
});
