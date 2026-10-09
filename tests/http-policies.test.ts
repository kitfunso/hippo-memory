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
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import type { Policy } from '../src/policies.js';
import type { JsonValue } from '../src/json.js';
import { makeRoot } from './_helpers/make-root.js';

type Body = { [key: string]: JsonValue };

/** Parse a fetch Response body against a caller-declared shape. */
async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: only used against this file's own /v1/policies route responses,
  // whose JSON shape is fixed by the handler in src/server.ts and checked by
  // the assertions immediately following each call site.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
let apiKeyB: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-pol');
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

function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}
interface CreatePolicyBody {
  policyName: string;
  policyText: string;
  validFrom?: string;
  validTo?: string;
}

async function createPolicy(body: CreatePolicyBody, key: CreateApiKeyResult = apiKey) {
  return fetch(`${handle.url}/v1/policies`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/policies (E2 bi-temporal first-class object)', () => {
  it('POST /v1/policies creates a policy (201 + Policy, version 1)', async () => {
    const res = await createPolicy({ policyName: 'Retention', policyText: 'delete after 90d', validFrom: '2026-01-01' });
    expect(res.status).toBe(201);
    const body = await jsonAs<{ policy: Policy }>(res);
    expect(body.policy.policyName).toBe('Retention');
    expect(body.policy.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(body.policy.version).toBe(1);
    expect(body.policy.status).toBe('active');
  });

  it('GET /v1/policies lists + filters by status', async () => {
    const v1 = (await jsonAs<{ policy: Policy }>(await createPolicy({ policyName: 'P', policyText: 'a' }))).policy;
    await fetch(`${handle.url}/v1/policies/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ policyText: 'b', changeSummary: 'c' }),
    });
    const all = await jsonAs<{ policies: Policy[] }>(await fetch(`${handle.url}/v1/policies`, { headers: authHeaders() }));
    expect(all.policies.length).toBe(2);
    const active = await jsonAs<{ policies: Policy[] }>(await fetch(`${handle.url}/v1/policies?status=active`, { headers: authHeaders() }));
    expect(active.policies.length).toBe(1);
    expect(active.policies[0].version).toBe(2);
  });

  it('GET /v1/policies/asof returns active policies in force at a valid-time', async () => {
    await createPolicy({ policyName: 'W', policyText: 'win', validFrom: '2026-01-01', validTo: '2026-06-01' });
    const inForce = await jsonAs<{ policies: Policy[] }>(await fetch(`${handle.url}/v1/policies/asof?date=2026-03-01`, { headers: authHeaders() }));
    expect(inForce.policies.length).toBe(1);
    // half-open: == valid_to not in force
    const atEnd = await jsonAs<{ policies: Policy[] }>(await fetch(`${handle.url}/v1/policies/asof?date=2026-06-01`, { headers: authHeaders() }));
    expect(atEnd.policies.length).toBe(0);
    // missing date -> 400
    const noDate = await fetch(`${handle.url}/v1/policies/asof`, { headers: authHeaders() });
    expect(noDate.status).toBe(400);
  });

  it('GET /v1/policies/:id returns single + 404 on missing', async () => {
    const created = (await jsonAs<{ policy: Policy }>(await createPolicy({ policyName: 'X', policyText: 'a' }))).policy;
    expect((await fetch(`${handle.url}/v1/policies/${created.id}`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/policies/99999`, { headers: authHeaders() })).status).toBe(404);
  });

  it('POST /v1/policies/:id/supersede creates v2 (+409 on re-supersede)', async () => {
    const v1 = (await jsonAs<{ policy: Policy }>(await createPolicy({ policyName: 'B', policyText: 'a' }))).policy;
    const sup = await fetch(`${handle.url}/v1/policies/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ policyText: 'b', changeSummary: 'x' }),
    });
    expect(sup.status).toBe(200);
    expect((await jsonAs<{ policy: Policy }>(sup)).policy.version).toBe(2);
    const conflict = await fetch(`${handle.url}/v1/policies/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ policyText: 'c' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/policies/:id/close retires (+409 on re-close)', async () => {
    const p = (await jsonAs<{ policy: Policy }>(await createPolicy({ policyName: 'C', policyText: 'a' }))).policy;
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
    const created = (await jsonAs<{ policy: Policy }>(await createPolicy({ policyName: 'secret', policyText: 'a' }))).policy;
    const bList = await jsonAs<{ policies: Policy[] }>(await fetch(`${handle.url}/v1/policies`, { headers: authHeaders(apiKeyB) }));
    expect(bList.policies.length).toBe(0);
    expect((await fetch(`${handle.url}/v1/policies/${created.id}`, { headers: authHeaders(apiKeyB) })).status).toBe(404);
  });

  it('DoS cap on policyText (400); inverted valid_to (400)', async () => {
    expect((await createPolicy({ policyName: 'x', policyText: 'y'.repeat(4097) })).status).toBe(400);
    expect((await createPolicy({ policyName: 'x', policyText: 'y', validFrom: '2026-06-01', validTo: '2026-01-01' })).status).toBe(400);
  });

  const over = (cap: number): string => 'x'.repeat(cap + 1);
  const at = (cap: number): string => 'x'.repeat(cap);
  const ROOT = '/v1/policies';
  const MISSING = '/v1/policies/99999/supersede';
  // Each row also sends every later field invalid, and the supersede target does not exist,
  // so a row pins which check answers first as well as the reply text.
  const REPLIES: readonly (readonly [string, string, string, Body | undefined, number, string])[] = [
    ['list: an unknown status', 'GET', `${ROOT}?status=retired`, undefined, 400, 'status must be one of: active | superseded | closed | all (got "retired")'],
    ['create: blank policyName', 'POST', ROOT, { policyName: '  ', policyText: 7, validFrom: 7, validTo: 7 }, 400, 'policyName is required (non-empty string)'],
    ['create: policyName over the cap', 'POST', ROOT, { policyName: over(4096), policyText: 7, validFrom: 7, validTo: 7 }, 400, 'policyName exceeds 4096-character cap'],
    ['create: blank policyText', 'POST', ROOT, { policyName: 'p', policyText: '  ', validFrom: 7, validTo: 7 }, 400, 'policyText is required (non-empty string)'],
    ['create: policyText over the cap', 'POST', ROOT, { policyName: 'p', policyText: over(4096), validFrom: 7, validTo: 7 }, 400, 'policyText exceeds 4096-character cap'],
    ['create: validFrom not a string', 'POST', ROOT, { policyName: 'p', policyText: 't', validFrom: 7, validTo: 7 }, 400, 'validFrom must be a string'],
    ['create: validFrom over the cap', 'POST', ROOT, { policyName: 'p', policyText: 't', validFrom: over(64), validTo: 7 }, 400, 'validFrom exceeds 64-character cap'],
    ['create: validTo not a string', 'POST', ROOT, { policyName: 'p', policyText: 't', validTo: 7 }, 400, 'validTo must be a string'],
    ['create: validTo over the cap', 'POST', ROOT, { policyName: 'p', policyText: 't', validTo: over(64) }, 400, 'validTo exceeds 64-character cap'],
    ['supersede: blank policyText', 'POST', MISSING, { policyText: '  ', validFrom: 7, validTo: 7, changeSummary: 7 }, 400, 'policyText is required (non-empty string)'],
    ['supersede: policyText over the cap', 'POST', MISSING, { policyText: over(4096), validFrom: 7, validTo: 7, changeSummary: 7 }, 400, 'policyText exceeds 4096-character cap'],
    ['supersede: validFrom not a string', 'POST', MISSING, { policyText: 't', validFrom: 7, validTo: 7, changeSummary: 7 }, 400, 'validFrom must be a string'],
    ['supersede: validFrom over the cap', 'POST', MISSING, { policyText: 't', validFrom: over(64), validTo: 7, changeSummary: 7 }, 400, 'validFrom exceeds 64-character cap'],
    ['supersede: validTo not a string', 'POST', MISSING, { policyText: 't', validTo: 7, changeSummary: 7 }, 400, 'validTo must be a string'],
    ['supersede: validTo over the cap', 'POST', MISSING, { policyText: 't', validTo: over(64), changeSummary: 7 }, 400, 'validTo exceeds 64-character cap'],
    ['supersede: changeSummary not a string', 'POST', MISSING, { policyText: 't', changeSummary: 7 }, 400, 'changeSummary must be a string'],
    ['supersede: changeSummary over the cap', 'POST', MISSING, { policyText: 't', changeSummary: over(4096) }, 400, 'changeSummary exceeds 4096-character cap'],
    ['supersede: every field at its cap reaches the lookup', 'POST', MISSING, { policyText: at(4096), validFrom: at(64), validTo: at(64), changeSummary: at(4096) }, 404, 'policy 99999 not found'],
    ['supersede: null optional fields reach the lookup', 'POST', MISSING, { policyText: 't', validFrom: null, validTo: null, changeSummary: null }, 404, 'policy 99999 not found'],
  ];

  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
