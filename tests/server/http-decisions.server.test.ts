/**
 * E2 decision first-class object — HTTP route parity test.
 * Docs: docs/plans/2026-05-28-e2-decision-object.md
 *
 * Covers what only decisions have; the shared route rules run per kind in http-objects.server.test.ts.
 * 1. GET /v1/decisions lists + status filter
 * 2. a supersede weakens the replaced decision's memory in the same save, or fails whole
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import type { ServerHandle } from '../../src/server.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/sqlite/keys/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { Decision } from '../../src/domain/objects/decisions.js';
import { makeRoot } from '../_helpers/make-root.js';
import { jsonAs, authHeaders } from '../_helpers/http-objects-server.js';

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
  handle = await serve({ hippoRoot: home, port: 0, keep: ['objects'] });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

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
    await fetch(`${handle.url}/v1/decisions/${toClose.id}/close`, { method: 'POST', headers: authHeaders(apiKey) });

    const allRes = await fetch(`${handle.url}/v1/decisions`, { headers: authHeaders(apiKey) });
    expect(allRes.status).toBe(200);
    const all = await jsonAs<{ decisions: Decision[] }>(allRes);
    expect(all.decisions.length).toBe(2);

    const activeRes = await fetch(`${handle.url}/v1/decisions?status=active`, { headers: authHeaders(apiKey) });
    const active = await jsonAs<{ decisions: Decision[] }>(activeRes);
    expect(active.decisions.length).toBe(1);
    expect(active.decisions[0].status).toBe('active');
  });

  function supersede(id: number, text: string): Promise<Response> {
    return fetch(`${handle.url}/v1/decisions/${id}/supersede`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ text }),
    });
  }

  function memory(id: string | null) {
    const db = openHippoDb(home);
    try {
      // SAFETY: the SELECT list is exactly these three columns, and tags_json holds a JSON array of strings.
      const row = db.prepare('SELECT confidence, half_life_days, tags_json FROM memories WHERE id = ?').get(id) as
        | { confidence: string; half_life_days: number; tags_json: string }
        | undefined;
      if (!row) return undefined;
      // SAFETY: a memory's tags_json column holds a JSON array of strings.
      const tags = JSON.parse(row.tags_json) as string[];
      return { confidence: row.confidence, halfLife: row.half_life_days, tags };
    } finally {
      closeHippoDb(db);
    }
  }

  function count(table: string): number {
    const db = openHippoDb(home);
    try {
      // SAFETY: COUNT(*) AS n answers one row with one numeric column.
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } finally {
      closeHippoDb(db);
    }
  }

  it.skipIf(needsHippoDb('db'))('POST /v1/decisions/:id/supersede weakens the replaced decision memory', async () => {
    const first = (await jsonAs<{ decision: Decision }>(await createDecision('use postgres'))).decision;
    const res = await supersede(first.id, 'use sqlite');
    expect(res.status).toBe(201);
    const second = (await jsonAs<{ decision: Decision }>(res)).decision;
    const kept = memory(second.memoryId);
    expect(memory(first.memoryId)).toEqual({
      confidence: 'stale',
      halfLife: Math.floor(kept!.halfLife / 2),
      tags: [...kept!.tags, 'superseded'],
    });
    expect(kept).toMatchObject({ confidence: 'verified' });
  });

  it.skipIf(needsHippoDb('db'))(
    'a supersede whose weaken the store refuses fails and leaves the old decision active',
    async () => {
      const first = (await jsonAs<{ decision: Decision }>(await createDecision('use postgres'))).decision;
      const db = openHippoDb(home);
      try {
        db.exec(
          `CREATE TRIGGER refuse_weaken BEFORE UPDATE ON memories WHEN NEW.id = '${first.memoryId}' AND NEW.confidence = 'stale' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
        );
      } finally {
        closeHippoDb(db);
      }
      const res = await supersede(first.id, 'use sqlite');
      expect(res.status).toBe(500);
      const listed = await jsonAs<{ decisions: Decision[] }>(
        await fetch(`${handle.url}/v1/decisions`, { headers: authHeaders(apiKey) }),
      );
      expect(listed.decisions).toEqual([first]);
      expect([count('decisions'), count('memories')]).toEqual([1, 1]);
      expect(memory(first.memoryId)).toMatchObject({ confidence: 'verified' });
    },
  );
});
