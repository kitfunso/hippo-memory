/**
 * E2 prediction first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-26-e2-prediction-object.md
 *
 * Covers:
 * 1. POST /v1/predictions creates a row (201 + Prediction body)
 * 2. GET /v1/predictions filters by class + status
 * 3. GET /v1/predictions/:id returns single + 404 on missing
 * 4. POST /v1/predictions/:id/close updates the row
 * 5. Bearer auth required (no Authorization → 401)
 * 6. status filter validation (invalid → 400)
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
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-pred-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreatedApiKey;

beforeEach(async () => {
  home = makeRoot();
  // Provision an admin API key for the test tenant
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-pred', role: 'admin' });
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

function authHeaders() {
  return { 'authorization': `Bearer ${apiKey.plaintext}`, 'content-type': 'application/json' };
}

describe('HTTP /v1/predictions (E2 prediction, v0.31)', () => {
  it('POST /v1/predictions creates a prediction (201 + Prediction body)', async () => {
    const res = await fetch(`${handle.url}/v1/predictions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        claim: 'migration takes 2 days',
        classTag: 'migration-effort',
        estimate: 2,
        unit: 'days',
        targetDate: '2026-06-15',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { prediction: Record<string, unknown> };
    expect(body.prediction).toBeDefined();
    expect(body.prediction.classTag).toBe('migration-effort');
    expect(body.prediction.claimText).toBe('migration takes 2 days');
    expect(body.prediction.estimateValue).toBe(2);
    expect(body.prediction.estimateUnit).toBe('days');
    expect(body.prediction.targetDate).toBe('2026-06-15');
    expect(body.prediction.closureState).toBe('open');
    expect(body.prediction.id).toBeGreaterThan(0);
  });

  it('GET /v1/predictions filters by class and returns list', async () => {
    // Seed
    for (const claim of ['first claim text', 'second claim text']) {
      await fetch(`${handle.url}/v1/predictions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ claim, classTag: 'list-test', estimate: 1 }),
      });
    }
    const res = await fetch(`${handle.url}/v1/predictions?class=list-test&status=open`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { predictions: Array<Record<string, unknown>> };
    expect(body.predictions.length).toBe(2);
    expect(body.predictions.every((p) => p.classTag === 'list-test')).toBe(true);
    expect(body.predictions.every((p) => p.closureState === 'open')).toBe(true);
  });

  it('GET /v1/predictions/:id returns single + 404 on missing', async () => {
    const create = await fetch(`${handle.url}/v1/predictions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ claim: 'show test claim', classTag: 'show-test' }),
    });
    const created = (await create.json() as { prediction: { id: number } }).prediction;

    const getRes = await fetch(`${handle.url}/v1/predictions/${created.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json() as { prediction: Record<string, unknown> }).prediction;
    expect(fetched.id).toBe(created.id);

    const missingRes = await fetch(`${handle.url}/v1/predictions/99999`, { headers: authHeaders() });
    expect(missingRes.status).toBe(404);
  });

  it('POST /v1/predictions/:id/close updates the row', async () => {
    const create = await fetch(`${handle.url}/v1/predictions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ claim: 'close test claim', classTag: 'close-test', estimate: 1 }),
    });
    const created = (await create.json() as { prediction: { id: number } }).prediction;

    const closeRes = await fetch(`${handle.url}/v1/predictions/${created.id}/close`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ state: 'closed', actual: 3, note: 'took longer' }),
    });
    expect(closeRes.status).toBe(200);
    const closed = (await closeRes.json() as { prediction: Record<string, unknown> }).prediction;
    expect(closed.closureState).toBe('closed');
    expect(closed.actualValue).toBe(3);
    expect(closed.closureNote).toBe('took longer');
    expect(closed.closedAt).toBeDefined();
  });

  it('status filter validation: invalid status → 400', async () => {
    const res = await fetch(`${handle.url}/v1/predictions?class=x&status=invalid-state`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/status must be one of/);
  });

  it('claim length cap: >4096 chars → 400', async () => {
    const longClaim = 'x'.repeat(5000);
    const res = await fetch(`${handle.url}/v1/predictions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ claim: longClaim, classTag: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});
