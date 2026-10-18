/**
 * E2 customer_note (entity-scoped) - HTTP route parity test.
 * Docs: docs/plans/2026-06-01-e2-customer-note-object.md
 *
 * Covers what only customer notes have; the shared route rules run per kind in http-objects.test.ts.
 * GET list + status + customer filter (many-per-customer).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/sqlite/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { CustomerNote } from '../../src/objects/customer-notes.js';
import { makeRoot } from '../_helpers/make-root.js';

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every /v1/customer-notes response body is written by this
  // server's own route handlers (src/server.ts) under test; each call
  // site's <T> matches exactly the JSON shape that handler sends.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-note');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-note', role: 'admin' });
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
async function createNote(body: { customer: string; note: string }, key: CreateApiKeyResult = apiKey) {
  return fetch(`${handle.url}/v1/customer-notes`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body),
  });
}

describe('HTTP /v1/customer-notes (entity-scoped first-class object)', () => {
  it('GET /v1/customer-notes lists + filters by status + customer (many-per-customer)', async () => {
    await createNote({ customer: 'Acme', note: 'n1' });
    await createNote({ customer: 'Acme', note: 'n2' });
    await createNote({ customer: 'Beta', note: 'b1' });
    const all = await jsonAs<{ notes: CustomerNote[] }>(
      await fetch(`${handle.url}/v1/customer-notes`, { headers: authHeaders() }),
    );
    expect(all.notes.length).toBe(3);
    const acme = await jsonAs<{ notes: CustomerNote[] }>(
      await fetch(`${handle.url}/v1/customer-notes?customer=Acme`, { headers: authHeaders() }),
    );
    expect(acme.notes.length).toBe(2); // many per customer
    const acmeActive = await jsonAs<{ notes: CustomerNote[] }>(
      await fetch(`${handle.url}/v1/customer-notes?customer=Acme&status=active`, { headers: authHeaders() }),
    );
    expect(acmeActive.notes.length).toBe(2);
    const padded = await jsonAs<{ notes: CustomerNote[] }>(
      await fetch(`${handle.url}/v1/customer-notes?customer=%20Acme%20`, { headers: authHeaders() }),
    );
    expect(padded.notes.length).toBe(2); // the filter is trimmed before the lookup
  });
});
