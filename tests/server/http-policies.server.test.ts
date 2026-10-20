/**
 * E2 policy first-class object (bi-temporal-first) - HTTP route parity test.
 * Docs: docs/plans/2026-05-30-e2-policy-object.md
 *
 * Covers what only policies have; the shared route rules run per kind in http-objects.server.test.ts.
 * 1. GET /v1/policies lists + status filter
 * 2. GET /v1/policies/asof (as-of query; date + name; missing date 400)
 * 3. inverted valid_to (400)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/sqlite/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { Policy } from '../../src/domain/objects/policies.js';
import { makeRoot } from '../_helpers/make-root.js';

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

beforeEach(async () => {
  home = makeRoot('http-pol');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-pol', role: 'admin' });
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
interface CreatePolicyBody {
  policyName: string;
  policyText: string;
  validFrom?: string;
  validTo?: string;
}

async function createPolicy(body: CreatePolicyBody, key: CreateApiKeyResult = apiKey) {
  return fetch(`${handle.url}/v1/policies`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/policies (bi-temporal first-class object)', () => {
  it('GET /v1/policies lists + filters by status', async () => {
    const v1 = (await jsonAs<{ policy: Policy }>(await createPolicy({ policyName: 'P', policyText: 'a' }))).policy;
    await fetch(`${handle.url}/v1/policies/${v1.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ policyText: 'b', changeSummary: 'c' }),
    });
    const all = await jsonAs<{ policies: Policy[] }>(
      await fetch(`${handle.url}/v1/policies`, { headers: authHeaders() }),
    );
    expect(all.policies.length).toBe(2);
    const active = await jsonAs<{ policies: Policy[] }>(
      await fetch(`${handle.url}/v1/policies?status=active`, { headers: authHeaders() }),
    );
    expect(active.policies.length).toBe(1);
    expect(active.policies[0].version).toBe(2);
  });

  it('GET /v1/policies/asof returns active policies in force at a valid-time', async () => {
    await createPolicy({ policyName: 'W', policyText: 'win', validFrom: '2026-01-01', validTo: '2026-06-01' });
    const inForce = await jsonAs<{ policies: Policy[] }>(
      await fetch(`${handle.url}/v1/policies/asof?date=2026-03-01`, { headers: authHeaders() }),
    );
    expect(inForce.policies.length).toBe(1);
    // half-open: == valid_to not in force
    const atEnd = await jsonAs<{ policies: Policy[] }>(
      await fetch(`${handle.url}/v1/policies/asof?date=2026-06-01`, { headers: authHeaders() }),
    );
    expect(atEnd.policies.length).toBe(0);
    // missing date -> 400
    const noDate = await fetch(`${handle.url}/v1/policies/asof`, { headers: authHeaders() });
    expect(noDate.status).toBe(400);
  });

  it('inverted valid_to (400)', async () => {
    expect(
      (await createPolicy({ policyName: 'x', policyText: 'y', validFrom: '2026-06-01', validTo: '2026-01-01' })).status,
    ).toBe(400);
  });
});
