/**
 * E2 customer_note (entity-scoped) - HTTP route parity test.
 * Docs: docs/plans/2026-06-01-e2-customer-note-object.md
 *
 * Covers: POST create (201), GET list + status + customer filter, GET /:id + 404,
 * POST supersede (+409), POST close (+409), auth gate (401), status/limit validation
 * (400), cross-tenant isolation, DoS cap (400), many-notes-per-customer.
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
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-note-'));
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
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-note', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-note-b', role: 'admin' });
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
async function createNote(body: Record<string, unknown>, key: CreatedApiKey = apiKey) {
  return fetch(`${handle.url}/v1/customer-notes`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/customer-notes (E2 entity-scoped first-class object)', () => {
  it('POST /v1/customer-notes creates a note (201 + note, version 1)', async () => {
    const res = await createNote({ customer: 'Acme', note: 'renewal call' });
    expect(res.status).toBe(201);
    const body = await res.json() as { note: Record<string, unknown> };
    expect(body.note.customer).toBe('Acme');
    expect(body.note.note).toBe('renewal call');
    expect(body.note.version).toBe(1);
    expect(body.note.status).toBe('active');
  });

  it('GET /v1/customer-notes lists + filters by status + customer (many-per-customer)', async () => {
    await createNote({ customer: 'Acme', note: 'n1' });
    await createNote({ customer: 'Acme', note: 'n2' });
    await createNote({ customer: 'Beta', note: 'b1' });
    const all = await (await fetch(`${handle.url}/v1/customer-notes`, { headers: authHeaders() })).json() as { notes: unknown[] };
    expect(all.notes.length).toBe(3);
    const acme = await (await fetch(`${handle.url}/v1/customer-notes?customer=Acme`, { headers: authHeaders() })).json() as { notes: unknown[] };
    expect(acme.notes.length).toBe(2); // many per customer
    const acmeActive = await (await fetch(`${handle.url}/v1/customer-notes?customer=Acme&status=active`, { headers: authHeaders() })).json() as { notes: unknown[] };
    expect(acmeActive.notes.length).toBe(2);
  });

  it('GET /v1/customer-notes/:id + 404 on missing', async () => {
    const created = (await (await createNote({ customer: 'x', note: 'a' })).json() as { note: { id: number } }).note;
    expect((await fetch(`${handle.url}/v1/customer-notes/${created.id}`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/customer-notes/99999`, { headers: authHeaders() })).status).toBe(404);
  });

  it('POST /v1/customer-notes/:id/supersede creates v2 (+409 on re-supersede)', async () => {
    const v1 = (await (await createNote({ customer: 'b', note: 'a' })).json() as { note: { id: number } }).note;
    const sup = await fetch(`${handle.url}/v1/customer-notes/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: 'b', changeSummary: 'x' }),
    });
    expect(sup.status).toBe(200);
    expect((await sup.json() as { note: { version: number } }).note.version).toBe(2);
    const conflict = await fetch(`${handle.url}/v1/customer-notes/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: 'c' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/customer-notes/:id/close retires (+409 on re-close)', async () => {
    const n = (await (await createNote({ customer: 'c', note: 'a' })).json() as { note: { id: number } }).note;
    expect((await fetch(`${handle.url}/v1/customer-notes/${n.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/customer-notes/${n.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/customer-notes`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customer: 'x', note: 'y' }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.HIPPO_REQUIRE_AUTH; else process.env.HIPPO_REQUIRE_AUTH = prev;
    }
  });

  it('status filter (400) + fractional limit (400, shared parseListLimit)', async () => {
    expect((await fetch(`${handle.url}/v1/customer-notes?status=retired`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/customer-notes?limit=1.5`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/customer-notes?limit=5`, { headers: authHeaders() })).status).toBe(200);
  });

  it('cross-tenant isolation: tenant-b cannot see default notes', async () => {
    const created = (await (await createNote({ customer: 'secret', note: 'a' })).json() as { note: { id: number } }).note;
    const bList = await (await fetch(`${handle.url}/v1/customer-notes`, { headers: authHeaders(apiKeyB) })).json() as { notes: unknown[] };
    expect(bList.notes.length).toBe(0);
    expect((await fetch(`${handle.url}/v1/customer-notes/${created.id}`, { headers: authHeaders(apiKeyB) })).status).toBe(404);
  });

  it('DoS cap on note (400)', async () => {
    expect((await createNote({ customer: 'x', note: 'y'.repeat(8193) })).status).toBe(400);
  });
});
