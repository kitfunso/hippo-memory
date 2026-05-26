/**
 * J3 baserate detector — HTTP route parity test.
 * Docs: docs/plans/2026-05-26-j3-baserate-detector.md
 *
 * Covers:
 * 1. GET /v1/predictions/stats returns baserate JSON
 * 2. Missing class param returns 400
 * 3. Audit log has predict_baserate row post-call
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreatedApiKey } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { savePrediction, closePrediction } from '../src/predictions.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-j3-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreatedApiKey;

beforeEach(async () => {
  home = makeRoot();
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-j3', role: 'admin' });
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

describe('HTTP /v1/predictions/stats (J3, v0.31)', () => {
  it('returns baserate JSON for a class with closed predictions', async () => {
    // Seed: 2 closed predictions in class "http-test"
    for (const [est, act] of [[3, 5], [4, 6]] as Array<[number, number]>) {
      const p = savePrediction(home, 'default', {
        classTag: 'http-test',
        claimText: `est=${est} act=${act}`,
        estimateValue: est,
      });
      closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: act });
    }

    const res = await fetch(`${handle.url}/v1/predictions/stats?class=http-test`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { baserate: Record<string, unknown> };
    expect(body.baserate).toBeDefined();
    expect(body.baserate.classTag).toBe('http-test');
    expect(body.baserate.nClosed).toBe(2);
    expect(body.baserate.nRatioEligible).toBe(2);
    expect(typeof body.baserate.meanRatio).toBe('number');
    expect(typeof body.baserate.summary).toBe('string');
  });

  it('missing class param returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/predictions/stats`, { headers: authHeaders() });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/class param is required/);
  });

  it('audit log records predict_baserate row post-call', async () => {
    const p = savePrediction(home, 'default', { classTag: 'audit-http', claimText: 'audit test', estimateValue: 1 });
    closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: 2 });

    await fetch(`${handle.url}/v1/predictions/stats?class=audit-http`, { headers: authHeaders() });

    const db = openHippoDb(home);
    try {
      const rows = db.prepare(
        `SELECT op, target_id FROM audit_log WHERE op = 'predict_baserate'`
      ).all() as Array<{ op: string; target_id: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0].target_id).toBe('audit-http');
    } finally {
      closeHippoDb(db);
    }
  });

  it('empty class returns baserate with nClosed=0', async () => {
    const res = await fetch(`${handle.url}/v1/predictions/stats?class=never-existed`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { baserate: { nClosed: number; summary: string } };
    expect(body.baserate.nClosed).toBe(0);
    expect(body.baserate.summary).toBe('');
  });
});
