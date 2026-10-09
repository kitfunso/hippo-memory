/**
 * E2 customer_note (entity-scoped) - HTTP route parity test.
 * Docs: docs/plans/2026-06-01-e2-customer-note-object.md
 *
 * Covers: POST create (201), GET list + status + customer filter, GET /:id + 404,
 * POST supersede (+409), POST close (+409), auth gate (401), status/limit validation
 * (400), cross-tenant isolation, DoS cap (400), many-notes-per-customer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import type { CustomerNote } from '../src/customer-notes.js';
import type { JsonValue } from '../src/json.js';
import { makeRoot } from './_helpers/make-root.js';

type Body = { [key: string]: JsonValue };

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every /v1/customer-notes response body is written by this
  // server's own route handlers (src/server.ts) under test; each call
  // site's <T> matches exactly the JSON shape that handler sends.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
let apiKeyB: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-note');
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

function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}
async function createNote(body: { customer: string; note: string }, key: CreateApiKeyResult = apiKey) {
  return fetch(`${handle.url}/v1/customer-notes`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/customer-notes (entity-scoped first-class object)', () => {
  it('POST /v1/customer-notes creates a note (201 + note, version 1)', async () => {
    const res = await createNote({ customer: 'Acme', note: 'renewal call' });
    expect(res.status).toBe(201);
    const body = await jsonAs<{ note: CustomerNote }>(res);
    expect(body.note.customer).toBe('Acme');
    expect(body.note.note).toBe('renewal call');
    expect(body.note.version).toBe(1);
    expect(body.note.status).toBe('active');
  });

  it('GET /v1/customer-notes lists + filters by status + customer (many-per-customer)', async () => {
    await createNote({ customer: 'Acme', note: 'n1' });
    await createNote({ customer: 'Acme', note: 'n2' });
    await createNote({ customer: 'Beta', note: 'b1' });
    const all = await jsonAs<{ notes: CustomerNote[] }>(await fetch(`${handle.url}/v1/customer-notes`, { headers: authHeaders() }));
    expect(all.notes.length).toBe(3);
    const acme = await jsonAs<{ notes: CustomerNote[] }>(await fetch(`${handle.url}/v1/customer-notes?customer=Acme`, { headers: authHeaders() }));
    expect(acme.notes.length).toBe(2); // many per customer
    const acmeActive = await jsonAs<{ notes: CustomerNote[] }>(await fetch(`${handle.url}/v1/customer-notes?customer=Acme&status=active`, { headers: authHeaders() }));
    expect(acmeActive.notes.length).toBe(2);
    const padded = await jsonAs<{ notes: CustomerNote[] }>(await fetch(`${handle.url}/v1/customer-notes?customer=%20Acme%20`, { headers: authHeaders() }));
    expect(padded.notes.length).toBe(2); // the filter is trimmed before the lookup
  });

  it('GET /v1/customer-notes/:id + 404 on missing', async () => {
    const created = (await jsonAs<{ note: CustomerNote }>(await createNote({ customer: 'x', note: 'a' }))).note;
    expect((await fetch(`${handle.url}/v1/customer-notes/${created.id}`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/customer-notes/99999`, { headers: authHeaders() })).status).toBe(404);
  });

  it('POST /v1/customer-notes/:id/supersede creates v2 (+409 on re-supersede)', async () => {
    const v1 = (await jsonAs<{ note: CustomerNote }>(await createNote({ customer: 'b', note: 'a' }))).note;
    const sup = await fetch(`${handle.url}/v1/customer-notes/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: 'b', changeSummary: 'x' }),
    });
    expect(sup.status).toBe(200);
    expect((await jsonAs<{ note: CustomerNote }>(sup)).note.version).toBe(2);
    const conflict = await fetch(`${handle.url}/v1/customer-notes/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: 'c' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/customer-notes/:id/close retires (+409 on re-close)', async () => {
    const n = (await jsonAs<{ note: CustomerNote }>(await createNote({ customer: 'c', note: 'a' }))).note;
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
    const created = (await jsonAs<{ note: CustomerNote }>(await createNote({ customer: 'secret', note: 'a' }))).note;
    const bList = await jsonAs<{ notes: CustomerNote[] }>(await fetch(`${handle.url}/v1/customer-notes`, { headers: authHeaders(apiKeyB) }));
    expect(bList.notes.length).toBe(0);
    expect((await fetch(`${handle.url}/v1/customer-notes/${created.id}`, { headers: authHeaders(apiKeyB) })).status).toBe(404);
  });

  it('DoS cap on note (400)', async () => {
    expect((await createNote({ customer: 'x', note: 'y'.repeat(8193) })).status).toBe(400);
  });

  const over = (cap: number): string => 'x'.repeat(cap + 1);
  const at = (cap: number): string => 'x'.repeat(cap);
  const ROOT = '/v1/customer-notes';
  const MISSING = '/v1/customer-notes/99999/supersede';
  // Each row also sends every later field invalid, and the supersede target does not exist,
  // so a row pins which check answers first as well as the reply text.
  const REPLIES: readonly (readonly [string, string, string, Body | undefined, number, string])[] = [
    ['list: an unknown status', 'GET', `${ROOT}?status=retired`, undefined, 400, 'status must be one of: active | superseded | closed | all (got "retired")'],
    ['create: blank customer', 'POST', ROOT, { customer: '  ', note: 7 }, 400, 'customer is required (non-empty string)'],
    ['create: customer over the cap', 'POST', ROOT, { customer: over(256), note: 7 }, 400, 'customer exceeds 256-character cap'],
    ['create: blank note', 'POST', ROOT, { customer: 'c', note: '  ' }, 400, 'note is required (non-empty string)'],
    ['create: note over the cap', 'POST', ROOT, { customer: 'c', note: over(8192) }, 400, 'note exceeds 8192-character cap'],
    ['supersede: blank note', 'POST', MISSING, { note: '  ', changeSummary: 7 }, 400, 'note is required (non-empty string)'],
    ['supersede: note over the cap', 'POST', MISSING, { note: over(8192), changeSummary: 7 }, 400, 'note exceeds 8192-character cap'],
    ['supersede: changeSummary not a string', 'POST', MISSING, { note: 'n', changeSummary: 7 }, 400, 'changeSummary must be a string'],
    ['supersede: changeSummary over the cap', 'POST', MISSING, { note: 'n', changeSummary: over(4096) }, 400, 'changeSummary exceeds 4096-character cap'],
    ['supersede: every field at its cap reaches the lookup', 'POST', MISSING, { note: at(8192), changeSummary: at(4096) }, 404, 'customer note 99999 not found'],
    ['supersede: a null changeSummary reaches the lookup', 'POST', MISSING, { note: 'n', changeSummary: null }, 404, 'customer note 99999 not found'],
  ];

  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
