/**
 * E2 process first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-29-e2-process-object.md
 *
 * Covers:
 * 1. POST /v1/processes creates a row (201 + Process body, version 1)
 * 2. GET /v1/processes lists + status filter
 * 3. GET /v1/processes/:id returns single + 404 on missing
 * 4. POST /v1/processes/:id/supersede creates v2 (+409 on re-supersede of a superseded row)
 * 5. supersede requires steps (missing -> 400)
 * 6. POST /v1/processes/:id/close retires (+409 on re-close)
 * 7. Bearer auth required (no Authorization -> 401)
 * 8. status filter validation (invalid -> 400)
 * 9. cross-tenant isolation
 * 10. DoS cap on steps count (400)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreatedApiKey } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-proc-'));
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
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-proc', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-proc-b', role: 'admin' });
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

async function createProcess(processName: string, extra: Record<string, unknown> = {}, key: CreatedApiKey = apiKey) {
  return fetch(`${handle.url}/v1/processes`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ processName, ...extra }),
  });
}

describe('HTTP /v1/processes (E2 process first-class object)', () => {
  it('POST /v1/processes creates a process (201 + Process body, version 1)', async () => {
    const res = await createProcess('Release', { steps: ['test', 'bump', 'publish'], description: 'the ritual' });
    expect(res.status).toBe(201);
    const body = await res.json() as { process: Record<string, unknown> };
    expect(body.process.processName).toBe('Release');
    expect(body.process.steps).toEqual(['test', 'bump', 'publish']);
    expect(body.process.version).toBe(1);
    expect(body.process.status).toBe('active');
    expect(body.process.id as number).toBeGreaterThan(0);
  });

  it('GET /v1/processes lists and filters by status', async () => {
    const v1 = (await (await createProcess('Deploy', { steps: ['a'] })).json() as { process: { id: number } }).process;
    await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: ['a', 'b'], changeSummary: 'added b' }),
    });

    const allRes = await fetch(`${handle.url}/v1/processes`, { headers: authHeaders() });
    expect(allRes.status).toBe(200);
    const all = await allRes.json() as { processes: Array<Record<string, unknown>> };
    expect(all.processes.length).toBe(2);

    const activeRes = await fetch(`${handle.url}/v1/processes?status=active`, { headers: authHeaders() });
    const active = await activeRes.json() as { processes: Array<Record<string, unknown>> };
    expect(active.processes.length).toBe(1);
    expect(active.processes[0].version).toBe(2);
  });

  it('GET /v1/processes/:id returns single + 404 on missing', async () => {
    const created = (await (await createProcess('show me', { steps: ['a'] })).json() as { process: { id: number } }).process;
    const getRes = await fetch(`${handle.url}/v1/processes/${created.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(200);
    expect((await getRes.json() as { process: { id: number } }).process.id).toBe(created.id);

    const missing = await fetch(`${handle.url}/v1/processes/99999`, { headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

  it('POST /v1/processes/:id/supersede creates v2 (+409 on re-supersede of a superseded row)', async () => {
    const v1 = (await (await createProcess('Build', { steps: ['x'] })).json() as { process: { id: number } }).process;
    const supRes = await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: ['x', 'y'], changeSummary: 'added y' }),
    });
    expect(supRes.status).toBe(200);
    const v2 = (await supRes.json() as { process: { version: number; changeSummary: string } }).process;
    expect(v2.version).toBe(2);
    expect(v2.changeSummary).toBe('added y');

    // re-superseding the now-superseded v1 -> 409
    const conflict = await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: ['z'] }),
    });
    expect(conflict.status).toBe(409);
  });

  it('supersede requires steps (missing -> 400)', async () => {
    const v1 = (await (await createProcess('NeedsSteps', { steps: ['a'] })).json() as { process: { id: number } }).process;
    const res = await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/processes/:id/close retires a process (+409 on re-close)', async () => {
    const proc = (await (await createProcess('close me', { steps: ['a'] })).json() as { process: { id: number } }).process;
    const closeRes = await fetch(`${handle.url}/v1/processes/${proc.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(closeRes.status).toBe(200);
    expect((await closeRes.json() as { process: { status: string } }).process.status).toBe('closed');

    const recl = await fetch(`${handle.url}/v1/processes/${proc.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(recl.status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/processes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ processName: 'no auth attempt', steps: [] }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.HIPPO_REQUIRE_AUTH;
      else process.env.HIPPO_REQUIRE_AUTH = prev;
    }
  });

  it('status filter validation (invalid -> 400)', async () => {
    const res = await fetch(`${handle.url}/v1/processes?status=retired`, { headers: authHeaders() });
    expect(res.status).toBe(400);
  });

  it('cross-tenant isolation: tenant-b cannot see default-tenant processes', async () => {
    const created = (await (await createProcess('default secret', { steps: ['a'] })).json() as { process: { id: number } }).process;
    const bList = await (await fetch(`${handle.url}/v1/processes`, { headers: authHeaders(apiKeyB) })).json() as { processes: unknown[] };
    expect(bList.processes.length).toBe(0);
    const bGet = await fetch(`${handle.url}/v1/processes/${created.id}`, { headers: authHeaders(apiKeyB) });
    expect(bGet.status).toBe(404);
  });

  it('DoS cap: steps over 200 -> 400', async () => {
    const res = await createProcess('too many', { steps: Array(201).fill('x') });
    expect(res.status).toBe(400);
  });
});
