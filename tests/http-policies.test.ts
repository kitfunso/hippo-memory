/**
 * E2 policy first-class object (bi-temporal-first) - HTTP route parity test.
 * Docs: docs/plans/2026-05-30-e2-policy-object.md
 *
 * Covers:
 * 1. POST /v1/policies creates (201 + Policy, version 1)
 * 2. GET /v1/policies lists + status filter
 * 3. GET /v1/policies/asof (as-of query; date + name)
 * 4. GET /v1/policies/:id + 404
 * 5. POST /v1/policies/:id/supersede (+409 on re-supersede)
 * 6. POST /v1/policies/:id/close (+409 on re-close)
 * 7. Bearer auth gate (401)
 * 8. status filter validation (400)
 * 9. cross-tenant isolation
 * 10. DoS cap on policyText (400); inverted valid_to (400); missing asof date (400)
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
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-pol-'));
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
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-pol', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-pol-b', role: 'admin' });
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
async function createPolicy(body: Record<string, unknown>, key: CreatedApiKey = apiKey) {
  return fetch(`${handle.url}/v1/policies`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/policies (E2 bi-temporal first-class object)', () => {
  it('POST /v1/policies creates a policy (201 + Policy, version 1)', async () => {
    const res = await createPolicy({ policyName: 'Retention', policyText: 'delete after 90d', validFrom: '2026-01-01' });
    expect(res.status).toBe(201);
    const body = await res.json() as { policy: Record<string, unknown> };
    expect(body.policy.policyName).toBe('Retention');
    expect(body.policy.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(body.policy.version).toBe(1);
    expect(body.policy.status).toBe('active');
  });

  it('GET /v1/policies lists + filters by status', async () => {
    const v1 = (await (await createPolicy({ policyName: 'P', policyText: 'a' })).json() as { policy: { id: number } }).policy;
    await fetch(`${handle.url}/v1/policies/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ policyText: 'b', changeSummary: 'c' }),
    });
    const all = await (await fetch(`${handle.url}/v1/policies`, { headers: authHeaders() })).json() as { policies: unknown[] };
    expect(all.policies.length).toBe(2);
    const active = await (await fetch(`${handle.url}/v1/policies?status=active`, { headers: authHeaders() })).json() as { policies: Array<{ version: number }> };
    expect(active.policies.length).toBe(1);
    expect(active.policies[0].version).toBe(2);
  });

  it('GET /v1/policies/asof returns active policies in force at a valid-time', async () => {
    await createPolicy({ policyName: 'W', policyText: 'win', validFrom: '2026-01-01', validTo: '2026-06-01' });
    const inForce = await (await fetch(`${handle.url}/v1/policies/asof?date=2026-03-01`, { headers: authHeaders() })).json() as { policies: unknown[] };
    expect(inForce.policies.length).toBe(1);
    // half-open: == valid_to not in force
    const atEnd = await (await fetch(`${handle.url}/v1/policies/asof?date=2026-06-01`, { headers: authHeaders() })).json() as { policies: unknown[] };
    expect(atEnd.policies.length).toBe(0);
    // missing date -> 400
    const noDate = await fetch(`${handle.url}/v1/policies/asof`, { headers: authHeaders() });
    expect(noDate.status).toBe(400);
  });

  it('GET /v1/policies/:id returns single + 404 on missing', async () => {
    const created = (await (await createPolicy({ policyName: 'X', policyText: 'a' })).json() as { policy: { id: number } }).policy;
    expect((await fetch(`${handle.url}/v1/policies/${created.id}`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/policies/99999`, { headers: authHeaders() })).status).toBe(404);
  });

  it('POST /v1/policies/:id/supersede creates v2 (+409 on re-supersede)', async () => {
    const v1 = (await (await createPolicy({ policyName: 'B', policyText: 'a' })).json() as { policy: { id: number } }).policy;
    const sup = await fetch(`${handle.url}/v1/policies/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ policyText: 'b', changeSummary: 'x' }),
    });
    expect(sup.status).toBe(200);
    expect((await sup.json() as { policy: { version: number } }).policy.version).toBe(2);
    const conflict = await fetch(`${handle.url}/v1/policies/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ policyText: 'c' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/policies/:id/close retires (+409 on re-close)', async () => {
    const p = (await (await createPolicy({ policyName: 'C', policyText: 'a' })).json() as { policy: { id: number } }).policy;
    expect((await fetch(`${handle.url}/v1/policies/${p.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/policies/${p.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/policies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policyName: 'x', policyText: 'y' }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.HIPPO_REQUIRE_AUTH; else process.env.HIPPO_REQUIRE_AUTH = prev;
    }
  });

  it('status filter validation (invalid -> 400)', async () => {
    expect((await fetch(`${handle.url}/v1/policies?status=retired`, { headers: authHeaders() })).status).toBe(400);
  });

  it('fractional / non-integer limit -> 400 (not a 500 from SQLite; codex round-3 P2)', async () => {
    expect((await fetch(`${handle.url}/v1/policies?limit=1.5`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/policies?limit=abc`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/policies?limit=0`, { headers: authHeaders() })).status).toBe(400);
    // a valid integer limit still works
    expect((await fetch(`${handle.url}/v1/policies?limit=5`, { headers: authHeaders() })).status).toBe(200);
  });

  it('cross-tenant isolation: tenant-b cannot see default policies', async () => {
    const created = (await (await createPolicy({ policyName: 'secret', policyText: 'a' })).json() as { policy: { id: number } }).policy;
    const bList = await (await fetch(`${handle.url}/v1/policies`, { headers: authHeaders(apiKeyB) })).json() as { policies: unknown[] };
    expect(bList.policies.length).toBe(0);
    expect((await fetch(`${handle.url}/v1/policies/${created.id}`, { headers: authHeaders(apiKeyB) })).status).toBe(404);
  });

  it('DoS cap on policyText (400); inverted valid_to (400)', async () => {
    expect((await createPolicy({ policyName: 'x', policyText: 'y'.repeat(4097) })).status).toBe(400);
    expect((await createPolicy({ policyName: 'x', policyText: 'y', validFrom: '2026-06-01', validTo: '2026-01-01' })).status).toBe(400);
  });
});
