/**
 * v1.7.4 -- HTTP /v1/memories accepts `session_id` query param. Validation:
 * 256-char cap mirrors fresh_tail_session_id; over-cap rejects with 400.
 * When set and the (tenant, session) has active goals, api.recall applies
 * the dlPFC goal-stack boost on its primary BM25 band, observable via
 * goal_recall_log writes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal } from '../src/goals.js';
import { serve, type ServerHandle } from '../src/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-goal-boost-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;
const tenantId = 'default';
const sessionId = 'sess-http-1.7.4';

beforeEach(async () => {
  home = makeRoot();
  remember({ hippoRoot: home, tenantId, actor: { subject: 'test', role: 'admin' } }, {
    content: 'auth bug fix details',
    tags: ['fix-auth'],
  });
  pushGoal(home, { sessionId, tenantId, goalName: 'fix-auth' });
  handle = await serve({ hippoRoot: home, port: 0 });
});
afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories session_id (v1.7.4)', () => {
  it('session_id is accepted and applies the goal-stack boost (goal_recall_log row written)', async () => {
    const url = `${handle.url}/v1/memories?q=auth&session_id=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const db = openHippoDb(home);
    try {
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE session_id = ?`,
      ).get(sessionId) as { c: number }).c;
      expect(count).toBeGreaterThan(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('session_id omitted: no boost, no goal_recall_log row (v1.7.3 baseline)', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=auth`);
    expect(res.status).toBe(200);
    const db = openHippoDb(home);
    try {
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM goal_recall_log WHERE session_id = ?`,
      ).get(sessionId) as { c: number }).c;
      expect(count).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('session_id over the 256-char cap rejects with 400', async () => {
    const overCap = 'x'.repeat(257);
    const res = await fetch(
      `${handle.url}/v1/memories?q=auth&session_id=${encodeURIComponent(overCap)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/session_id.*256/i);
  });
});
