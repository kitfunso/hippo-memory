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
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import type { Decision } from '../src/objects/decisions.js';
import type { JsonValue } from '../src/util/json.js';
import { makeRoot } from './_helpers/make-root.js';

type Body = { [key: string]: JsonValue };

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every response in this suite comes from the /v1/decisions route
  // handlers under test (src/server.ts sendJson calls), which always return
  // the `{ decision: Decision }` / `{ decisions: Decision[] }` envelopes the
  // caller requests as T; the status-code assertions before each call
  // confirm the success path ran.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
let apiKeyB: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-dec');
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

function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}

async function createDecision(
  text: string,
  extra: { context?: string; supersedesDecisionId?: number } = {},
  key: CreateApiKeyResult = apiKey,
) {
  return fetch(`${handle.url}/v1/decisions`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({ text, ...extra }),
  });
}

describe('HTTP /v1/decisions (decision first-class object)', () => {
  it('POST /v1/decisions creates a decision (201 + Decision body)', async () => {
    const res = await createDecision('use Postgres', { context: 'scale' });
    expect(res.status).toBe(201);
    const body = await jsonAs<{ decision: Decision }>(res);
    expect(body.decision.decisionText).toBe('use Postgres');
    expect(body.decision.context).toBe('scale');
    expect(body.decision.status).toBe('active');
    expect(body.decision.id).toBeGreaterThan(0);
  });

  it('GET /v1/decisions lists and filters by status', async () => {
    await createDecision('active one');
    const toClose = (await jsonAs<{ decision: Decision }>(await createDecision('to close'))).decision;
    await fetch(`${handle.url}/v1/decisions/${toClose.id}/close`, { method: 'POST', headers: authHeaders() });

    const allRes = await fetch(`${handle.url}/v1/decisions`, { headers: authHeaders() });
    expect(allRes.status).toBe(200);
    const all = await jsonAs<{ decisions: Decision[] }>(allRes);
    expect(all.decisions.length).toBe(2);

    const activeRes = await fetch(`${handle.url}/v1/decisions?status=active`, { headers: authHeaders() });
    const active = await jsonAs<{ decisions: Decision[] }>(activeRes);
    expect(active.decisions.length).toBe(1);
    expect(active.decisions[0].status).toBe('active');
  });

  it('GET /v1/decisions/:id returns single + 404 on missing', async () => {
    const created = (await jsonAs<{ decision: Decision }>(await createDecision('show me'))).decision;
    const getRes = await fetch(`${handle.url}/v1/decisions/${created.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(200);
    expect((await jsonAs<{ decision: Decision }>(getRes)).decision.id).toBe(created.id);

    const missing = await fetch(`${handle.url}/v1/decisions/99999`, { headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

  it('POST /v1/decisions/:id/supersede creates a successor and supersedes the old', async () => {
    const old = (await jsonAs<{ decision: Decision }>(await createDecision('use REST'))).decision;
    const supRes = await fetch(`${handle.url}/v1/decisions/${old.id}/supersede`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'use GraphQL' }),
    });
    expect(supRes.status).toBe(201);
    const successor = (await jsonAs<{ decision: Decision }>(supRes)).decision;
    expect(successor.status).toBe('active');

    const oldReloadRes = await fetch(`${handle.url}/v1/decisions/${old.id}`, { headers: authHeaders() });
    const oldReload = await jsonAs<{ decision: Decision }>(oldReloadRes);
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
    const d = (await jsonAs<{ decision: Decision }>(await createDecision('use webpack'))).decision;
    const closeRes = await fetch(`${handle.url}/v1/decisions/${d.id}/close`, { method: 'POST', headers: authHeaders() });
    expect(closeRes.status).toBe(200);
    expect((await jsonAs<{ decision: Decision }>(closeRes)).decision.status).toBe('closed');

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
    const created = (await jsonAs<{ decision: Decision }>(await createDecision('default secret'))).decision;
    const bListRes = await fetch(`${handle.url}/v1/decisions`, { headers: authHeaders(apiKeyB) });
    const bList = await jsonAs<{ decisions: Decision[] }>(bListRes);
    expect(bList.decisions.length).toBe(0);
    const bGet = await fetch(`${handle.url}/v1/decisions/${created.id}`, { headers: authHeaders(apiKeyB) });
    expect(bGet.status).toBe(404);
  });

  it('DoS cap: text over 4096 chars -> 400', async () => {
    const res = await createDecision('x'.repeat(4097));
    expect(res.status).toBe(400);
  });

  const over = (cap: number): string => 'x'.repeat(cap + 1);
  const at = (cap: number): string => 'x'.repeat(cap);
  const ROOT = '/v1/decisions';
  const MISSING = '/v1/decisions/99999/supersede';
  const SHORT = 'Memory content too short (0 chars, minimum 3): ""';
  const NO_TARGET = 'saveDecision: decision 99999 to supersede not found for tenant default';
  // Each row also sends every later field invalid, and every superseded id is missing,
  // so a row pins which check answers first as well as the reply text.
  const REPLIES: readonly (readonly [string, string, string, Body | undefined, number, string])[] = [
    ['list: an unknown status', 'GET', `${ROOT}?status=retired`, undefined, 400, 'status must be one of: active | superseded | closed | all (got "retired")'],
    ['create: empty text', 'POST', ROOT, { text: '', context: 7, supersedesDecisionId: 0 }, 400, 'text is required (non-empty string)'],
    ['create: text over the cap', 'POST', ROOT, { text: over(4096), context: 7, supersedesDecisionId: 0 }, 400, 'text exceeds 4096-character cap'],
    ['create: context not a string', 'POST', ROOT, { text: 't', context: 7, supersedesDecisionId: 0 }, 400, 'context must be a string'],
    ['create: context over the cap', 'POST', ROOT, { text: 't', context: over(4096), supersedesDecisionId: 0 }, 400, 'context exceeds 4096-character cap'],
    ['create: supersedesDecisionId of zero', 'POST', ROOT, { text: 't', supersedesDecisionId: 0 }, 400, 'supersedesDecisionId must be a positive integer'],
    ['create: a fractional supersedesDecisionId', 'POST', ROOT, { text: 't', supersedesDecisionId: 1.5 }, 400, 'supersedesDecisionId must be a positive integer'],
    ['create: every field at its cap reaches the store', 'POST', ROOT, { text: at(4096), context: at(4096), supersedesDecisionId: 99999 }, 409, NO_TARGET],
    ['create: a null context reaches the store', 'POST', ROOT, { text: 'ttt', context: null, supersedesDecisionId: 99999 }, 409, NO_TARGET],
    ['create: spaces-only text passes the route check', 'POST', ROOT, { text: '  ' }, 400, SHORT],
    ['supersede: empty text', 'POST', MISSING, { text: '', context: 7 }, 400, 'text is required (non-empty string)'],
    ['supersede: text over the cap', 'POST', MISSING, { text: over(4096), context: 7 }, 400, 'text exceeds 4096-character cap'],
    ['supersede: context not a string', 'POST', MISSING, { text: 't', context: 7 }, 400, 'context must be a string'],
    ['supersede: context over the cap', 'POST', MISSING, { text: 't', context: over(4096) }, 400, 'context exceeds 4096-character cap'],
    ['supersede: every field at its cap reaches the store', 'POST', MISSING, { text: at(4096), context: at(4096) }, 404, NO_TARGET],
    ['supersede: a null context reaches the store', 'POST', MISSING, { text: 'ttt', context: null }, 404, NO_TARGET],
    ['supersede: spaces-only text passes the route check', 'POST', MISSING, { text: '  ' }, 400, SHORT],
  ];

  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
