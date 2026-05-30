/**
 * E2 project_brief first-class object (repo-scoped / auto-refreshes) - HTTP route test.
 * Docs: docs/plans/2026-05-30-e2-project-brief-object.md
 *
 * Covers:
 * 1. POST /v1/project-briefs creates (201 + brief, version 1)
 * 2. GET /v1/project-briefs lists + status filter + repo filter
 * 3. POST /v1/project-briefs/refresh writes a brief; dryRun returns {markdown} without writing
 * 4. GET /v1/project-briefs/:id + 404
 * 5. POST /v1/project-briefs/:id/supersede (+409 on re-supersede)
 * 6. POST /v1/project-briefs/:id/close (+409 on re-close)
 * 7. Bearer auth gate (401)
 * 8. status filter validation (400); fractional limit (400, shared parseListLimit)
 * 9. cross-tenant isolation
 * 10. DoS cap on summary (400)
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
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-brief-'));
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
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-brief', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-brief-b', role: 'admin' });
  } finally { closeHippoDb(db); }
  handle = await serve({ hippoRoot: home, port: 0 });
});
afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

function authHeaders(key: CreatedApiKey = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}
async function createBrief(body: Record<string, unknown>, key: CreatedApiKey = apiKey) {
  return fetch(`${handle.url}/v1/project-briefs`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/project-briefs (E2 repo-scoped first-class object)', () => {
  it('POST /v1/project-briefs creates a brief (201 + brief, version 1)', async () => {
    const res = await createBrief({ repo: 'hippo', summary: 'agent-memory lib' });
    expect(res.status).toBe(201);
    const body = await res.json() as { brief: Record<string, unknown> };
    expect(body.brief.repo).toBe('hippo');
    expect(body.brief.summary).toBe('agent-memory lib');
    expect(body.brief.version).toBe(1);
    expect(body.brief.status).toBe('active');
  });

  it('GET /v1/project-briefs lists + filters by status + repo', async () => {
    const v1 = (await (await createBrief({ repo: 'r', summary: 'a' })).json() as { brief: { id: number } }).brief;
    await createBrief({ repo: 'other', summary: 'x' });
    await fetch(`${handle.url}/v1/project-briefs/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ summary: 'b', changeSummary: 'c' }),
    });
    const all = await (await fetch(`${handle.url}/v1/project-briefs`, { headers: authHeaders() })).json() as { briefs: unknown[] };
    expect(all.briefs.length).toBe(3);
    const repoR = await (await fetch(`${handle.url}/v1/project-briefs?repo=r`, { headers: authHeaders() })).json() as { briefs: unknown[] };
    expect(repoR.briefs.length).toBe(2);
    const active = await (await fetch(`${handle.url}/v1/project-briefs?repo=r&status=active`, { headers: authHeaders() })).json() as { briefs: Array<{ version: number }> };
    expect(active.briefs.length).toBe(1);
    expect(active.briefs[0].version).toBe(2);
  });

  it('POST /v1/project-briefs/refresh writes a brief; dryRun returns markdown without writing', async () => {
    // dry-run on an empty repo: returns a valid digest, writes nothing
    const dry = await fetch(`${handle.url}/v1/project-briefs/refresh`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ repo: 'hippo', dryRun: true }),
    });
    expect(dry.status).toBe(200);
    const dryBody = await dry.json() as { markdown: string; receiptCount: number };
    expect(dryBody.receiptCount).toBe(0);
    expect(dryBody.markdown).toContain('# Project Brief: hippo');
    const afterDry = await (await fetch(`${handle.url}/v1/project-briefs?repo=hippo`, { headers: authHeaders() })).json() as { briefs: unknown[] };
    expect(afterDry.briefs.length).toBe(0);

    // real refresh writes v1
    const res = await fetch(`${handle.url}/v1/project-briefs/refresh`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ repo: 'hippo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { brief: { version: number; repo: string } };
    expect(body.brief.version).toBe(1);
    expect(body.brief.repo).toBe('hippo');
    const after = await (await fetch(`${handle.url}/v1/project-briefs?repo=hippo`, { headers: authHeaders() })).json() as { briefs: unknown[] };
    expect(after.briefs.length).toBe(1);
  });

  it('GET /v1/project-briefs/:id + 404 on missing', async () => {
    const created = (await (await createBrief({ repo: 'x', summary: 'a' })).json() as { brief: { id: number } }).brief;
    expect((await fetch(`${handle.url}/v1/project-briefs/${created.id}`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/project-briefs/99999`, { headers: authHeaders() })).status).toBe(404);
  });

  it('POST /v1/project-briefs/:id/supersede creates v2 (+409 on re-supersede)', async () => {
    const v1 = (await (await createBrief({ repo: 'b', summary: 'a' })).json() as { brief: { id: number } }).brief;
    const sup = await fetch(`${handle.url}/v1/project-briefs/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ summary: 'b', changeSummary: 'x' }),
    });
    expect(sup.status).toBe(200);
    expect((await sup.json() as { brief: { version: number } }).brief.version).toBe(2);
    const conflict = await fetch(`${handle.url}/v1/project-briefs/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ summary: 'c' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/project-briefs/:id/close retires (+409 on re-close)', async () => {
    const b = (await (await createBrief({ repo: 'c', summary: 'a' })).json() as { brief: { id: number } }).brief;
    expect((await fetch(`${handle.url}/v1/project-briefs/${b.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/project-briefs/${b.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/project-briefs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'x', summary: 'y' }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.HIPPO_REQUIRE_AUTH; else process.env.HIPPO_REQUIRE_AUTH = prev;
    }
  });

  it('status filter (400) + fractional limit (400, shared parseListLimit)', async () => {
    expect((await fetch(`${handle.url}/v1/project-briefs?status=retired`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/project-briefs?limit=1.5`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/project-briefs?limit=5`, { headers: authHeaders() })).status).toBe(200);
  });

  it('cross-tenant isolation: tenant-b cannot see default briefs', async () => {
    const created = (await (await createBrief({ repo: 'secret', summary: 'a' })).json() as { brief: { id: number } }).brief;
    const bList = await (await fetch(`${handle.url}/v1/project-briefs`, { headers: authHeaders(apiKeyB) })).json() as { briefs: unknown[] };
    expect(bList.briefs.length).toBe(0);
    expect((await fetch(`${handle.url}/v1/project-briefs/${created.id}`, { headers: authHeaders(apiKeyB) })).status).toBe(404);
  });

  it('DoS cap on summary (400)', async () => {
    expect((await createBrief({ repo: 'x', summary: 'y'.repeat(8193) })).status).toBe(400);
  });
});
