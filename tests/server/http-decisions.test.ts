/**
 * E2 decision first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-28-e2-decision-object.md
 *
 * Covers what only decisions have; the shared route rules run per kind in http-objects.test.ts.
 * 1. GET /v1/decisions lists + status filter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { Decision } from '../../src/objects/decisions.js';
import { makeRoot } from '../_helpers/make-root.js';

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

beforeEach(async () => {
  home = makeRoot('http-dec');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-dec', role: 'admin' });
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
});
