/**
 * E2 decision first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-28-e2-decision-object.md
 *
 * Covers:
 * 1. POST /v1/decisions creates a row (201 + Decision body)
 * 2. GET /v1/decisions lists + status filter
 * 3. GET /v1/decisions/:id returns single + 404 on missing
 * 4. POST /v1/decisions/:id/supersede creates a successor + supersedes old (+409 on re-supersede)
 * 5. POST /v1/decisions/:id/close retires (+409 on re-close)
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

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-dec-'));
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
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-dec', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-dec-b', role: 'admin' });
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

async function createDecision(text: string, extra: Record<string, unknown> = {}, key: CreatedApiKey = apiKey) {
  return fetch(`${handle.url}/v1/decisions`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ text, ...extra }),
  });
}

describe('HTTP /v1/decisions (E2 decision first-class object)', () => {
  it('POST /v1/decisions creates a decision (201 + Decision body)', async () => {
    const res = await createDecision('use Postgres', { context: 'scale' });
    expect(res.status).toBe(201);
    const body = await res.json() as { decision: Record<string, unknown> };
    expect(body.decision.decisionText).toBe('use Postgres');
    expect(body.decision.context).toBe('scale');
    expect(body.decision.status).toBe('active');
    expect(body.decision.id as number).toBeGreaterThan(0);
  });

  it('GET /v1/decisions lists and filters by status', async () => {
    await createDecision('active one');
    const toClose = (await (await createDecision('to close')).json() as { decision: { id: number } }).decision;
    await fetch(`${handle.url}/v1/decisions/${toClose.id}/close`, { method: 'POST', headers: authHeaders() });

    const allRes = await fetch(`${handle.url}/v1/decisions`, { headers: authHeaders() });
    expect(allRes.status).toBe(200);
    const all = await allRes.json() as { decisions: Array<Record<string, unknown>> };
    expect(all.decisions.length).toBe(2);

    const activeRes = await fetch(`${handle.url}/v1/decisions?status=active`, { headers: authHeaders() });
    const active = await activeRes.json() as { decisions: Array<Record<string, unknown>> };
    expect(active.decisions.length).toBe(1);
    expect(active.decisions[0].status).toBe('active');
  });

  it('GET /v1/decisions/:id returns single + 404 on missing', async () => {
    const created = (await (await createDecision('show me')).json() as { decision: { id: number } }).decision;
    const getRes = await fetch(`${handle.url}/v1/decisions/${created.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(200);
    expect((await getRes.json() as { decision: { id: number } }).decision.id).toBe(created.id);

    const missing = await fetch(`${handle.url}/v1/decisions/99999`, { headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

  it('POST /v1/decisions/:id/supersede creates a successor and supersedes the old', async () => {
    const old = (await (await createDecision('use REST')).json() as { decision: { id: number } }).decision;
    const supRes = await fetch(`${handle.url}/v1/decisions/${old.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'use GraphQL' }),
    });
    expect(supRes.status).toBe(201);
    const successor = (await supRes.json() as { decision: { id: number; status: string } }).decision;
    expect(successor.status).toBe('active');

    const oldReload = await (await fetch(`${handle.url}/v1/decisions/${old.id}`, { headers: authHeaders() })).json() as { decision: { status: string; supersededBy: number } };
    expect(oldReload.decision.status).toBe('superseded');
    expect(oldReload.decision.supersededBy).toBe(successor.id);

    // re-superseding the already-superseded old -> 409
    const conflict = await fetch(`${handle.url}/v1/decisions/${old.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'third' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/decisions/:id/close retires an active decision (+409 on re-close)', async () => {
    const d = (await (await createDecision('use webpack')).json() as { decision: { id: number } }).decision;
    const closeRes = await fetch(`${handle.url}/v1/decisions/${d.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(closeRes.status).toBe(200);
    expect((await closeRes.json() as { decision: { status: string } }).decision.status).toBe('closed');

    const recl = await fetch(`${handle.url}/v1/decisions/${d.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(recl.status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    // The server is auth-optional on loopback by design (local CLI escape
    // hatch); HIPPO_REQUIRE_AUTH=1 forbids it. This proves the create route
    // runs through buildContextWithAuth rather than bypassing the gate.
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/decisions`, {
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
    const res = await fetch(`${handle.url}/v1/decisions?status=retired`, { headers: authHeaders() });
    expect(res.status).toBe(400);
  });

  it('cross-tenant isolation: tenant-b cannot see default-tenant decisions', async () => {
    const created = (await (await createDecision('default secret')).json() as { decision: { id: number } }).decision;
    const bList = await (await fetch(`${handle.url}/v1/decisions`, { headers: authHeaders(apiKeyB) })).json() as { decisions: unknown[] };
    expect(bList.decisions.length).toBe(0);
    const bGet = await fetch(`${handle.url}/v1/decisions/${created.id}`, { headers: authHeaders(apiKeyB) });
    expect(bGet.status).toBe(404);
  });

  it('DoS cap: text over 4096 chars -> 400', async () => {
    const res = await createDecision('x'.repeat(4097));
    expect(res.status).toBe(400);
  });
});
