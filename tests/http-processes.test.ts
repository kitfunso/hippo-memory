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
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import type { Process } from '../src/processes.js';
import type { JsonValue } from '../src/json.js';
import { makeRoot } from './_helpers/make-root.js';

type Body = { [key: string]: JsonValue };

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
let apiKeyB: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-proc');
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

function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: T is pinned by each call site to the exact JSON envelope the
  // /v1/processes route handlers (src/server.ts) return; every call site
  // asserts the specific fields it reads immediately after this call.
  return res.json() as Promise<T>;
}

interface ProcessCreateExtra {
  steps?: string[];
  description?: string;
}

async function createProcess(
  processName: string,
  extra: ProcessCreateExtra = {},
  key: CreateApiKeyResult = apiKey,
) {
  return fetch(`${handle.url}/v1/processes`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ processName, ...extra }),
  });
}

describe('HTTP /v1/processes (process first-class object)', () => {
  it('POST /v1/processes creates a process (201 + Process body, version 1)', async () => {
    const res = await createProcess('Release', { steps: ['test', 'bump', 'publish'], description: 'the ritual' });
    expect(res.status).toBe(201);
    const body = await jsonAs<{ process: Process }>(res);
    expect(body.process.processName).toBe('Release');
    expect(body.process.steps).toEqual(['test', 'bump', 'publish']);
    expect(body.process.version).toBe(1);
    expect(body.process.status).toBe('active');
    expect(body.process.id).toBeGreaterThan(0);
  });

  it('GET /v1/processes lists and filters by status', async () => {
    const v1 = (await jsonAs<{ process: Process }>(await createProcess('Deploy', { steps: ['a'] }))).process;
    await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: ['a', 'b'], changeSummary: 'added b' }),
    });

    const allRes = await fetch(`${handle.url}/v1/processes`, { headers: authHeaders() });
    expect(allRes.status).toBe(200);
    const all = await jsonAs<{ processes: Process[] }>(allRes);
    expect(all.processes.length).toBe(2);

    const activeRes = await fetch(`${handle.url}/v1/processes?status=active`, { headers: authHeaders() });
    const active = await jsonAs<{ processes: Process[] }>(activeRes);
    expect(active.processes.length).toBe(1);
    expect(active.processes[0].version).toBe(2);
  });

  it('GET /v1/processes/:id returns single + 404 on missing', async () => {
    const created = (await jsonAs<{ process: Process }>(await createProcess('show me', { steps: ['a'] }))).process;
    const getRes = await fetch(`${handle.url}/v1/processes/${created.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(200);
    expect((await jsonAs<{ process: Process }>(getRes)).process.id).toBe(created.id);

    const missing = await fetch(`${handle.url}/v1/processes/99999`, { headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

  it('POST /v1/processes/:id/supersede creates v2 (+409 on re-supersede of a superseded row)', async () => {
    const v1 = (await jsonAs<{ process: Process }>(await createProcess('Build', { steps: ['x'] }))).process;
    const supRes = await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: ['x', 'y'], changeSummary: 'added y' }),
    });
    expect(supRes.status).toBe(200);
    const v2 = (await jsonAs<{ process: Process }>(supRes)).process;
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
    const v1 = (await jsonAs<{ process: Process }>(await createProcess('NeedsSteps', { steps: ['a'] }))).process;
    const res = await fetch(`${handle.url}/v1/processes/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ steps: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/processes/:id/close retires a process (+409 on re-close)', async () => {
    const proc = (await jsonAs<{ process: Process }>(await createProcess('close me', { steps: ['a'] }))).process;
    const closeRes = await fetch(`${handle.url}/v1/processes/${proc.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(closeRes.status).toBe(200);
    expect((await jsonAs<{ process: Process }>(closeRes)).process.status).toBe('closed');

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
    const created = (await jsonAs<{ process: Process }>(await createProcess('default secret', { steps: ['a'] }))).process;
    const bList = await jsonAs<{ processes: Process[] }>(
      await fetch(`${handle.url}/v1/processes`, { headers: authHeaders(apiKeyB) }),
    );
    expect(bList.processes.length).toBe(0);
    const bGet = await fetch(`${handle.url}/v1/processes/${created.id}`, { headers: authHeaders(apiKeyB) });
    expect(bGet.status).toBe(404);
  });

  it('DoS cap: steps over 200 -> 400', async () => {
    const res = await createProcess('too many', { steps: Array(201).fill('x') });
    expect(res.status).toBe(400);
  });

  const over = (cap: number): string => 'x'.repeat(cap + 1);
  const at = (cap: number): string => 'x'.repeat(cap);
  const ROOT = '/v1/processes';
  const MISSING = '/v1/processes/99999/supersede';
  // Each row also sends every later field invalid, and the supersede target does not exist,
  // so a row pins which check answers first as well as the reply text.
  const REPLIES: readonly (readonly [string, string, string, Body | undefined, number, string])[] = [
    ['list: an unknown status', 'GET', `${ROOT}?status=retired`, undefined, 400, 'status must be one of: active | superseded | closed | all (got "retired")'],
    ['create: blank processName', 'POST', ROOT, { processName: '  ', steps: 7, description: 7 }, 400, 'processName is required (non-empty string)'],
    ['create: processName over the cap', 'POST', ROOT, { processName: over(4096), steps: 7, description: 7 }, 400, 'processName exceeds 4096-character cap'],
    ['create: steps not an array', 'POST', ROOT, { processName: 'p', steps: 7, description: 7 }, 400, 'steps must be an array of strings'],
    ['create: too many steps', 'POST', ROOT, { processName: 'p', steps: Array.from({ length: 201 }, () => 7), description: 7 }, 400, 'steps exceeds 200-step cap'],
    ['create: description not a string', 'POST', ROOT, { processName: 'p', steps: ['a'], description: 7 }, 400, 'description must be a string'],
    ['create: description over the cap', 'POST', ROOT, { processName: 'p', steps: ['a'], description: over(4096) }, 400, 'description exceeds 4096-character cap'],
    ['supersede: steps not an array', 'POST', MISSING, { steps: 7, changeSummary: 7, description: 7 }, 400, 'steps must be an array of strings'],
    ['supersede: no steps', 'POST', MISSING, { steps: [], changeSummary: 7, description: 7 }, 400, 'steps is required (at least one step) for a supersession'],
    ['supersede: changeSummary not a string', 'POST', MISSING, { steps: ['a'], changeSummary: 7, description: 7 }, 400, 'changeSummary must be a string'],
    ['supersede: changeSummary over the cap', 'POST', MISSING, { steps: ['a'], changeSummary: over(4096), description: 7 }, 400, 'changeSummary exceeds 4096-character cap'],
    ['supersede: description not a string', 'POST', MISSING, { steps: ['a'], description: 7 }, 400, 'description must be a string'],
    ['supersede: description over the cap', 'POST', MISSING, { steps: ['a'], description: over(4096) }, 400, 'description exceeds 4096-character cap'],
    ['supersede: every field at its cap reaches the lookup', 'POST', MISSING, { steps: ['a'], changeSummary: at(4096), description: at(4096) }, 404, 'process 99999 not found'],
    ['supersede: null optional fields reach the lookup', 'POST', MISSING, { steps: ['a'], changeSummary: null, description: null }, 404, 'process 99999 not found'],
  ];

  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
