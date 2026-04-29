import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { remember as apiRemember } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-srv-routes-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('server HTTP routes — memories', () => {
  let home: string;
  let globalHome: string;
  let originalHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (originalHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = originalHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('POST /v1/memories creates a memory and returns the envelope', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'http-canary-remember-77', kind: 'distilled' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { id: string; kind: string; tenantId: string };
    expect(body.id).toMatch(/^mem_/);
    expect(body.kind).toBe('distilled');
    expect(body.tenantId).toBe('default');
  });

  it('GET /v1/memories?q= returns matching results', async () => {
    apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      { content: 'recall-via-http alpha-token-http sentinel' },
    );
    apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      { content: 'unrelated noise' },
    );

    const res = await fetch(`${handle.url}/v1/memories?q=alpha-token-http&limit=5`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      results: Array<{ id: string; content: string; score: number }>;
      total: number;
      tokens: number;
    };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.content).toContain('alpha-token-http');
    expect(body.total).toBeGreaterThan(0);
    expect(body.tokens).toBeGreaterThan(0);
  });

  it('DELETE /v1/memories/:id removes the row', async () => {
    const { id } = apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      { content: 'forget-canary-target' },
    );
    const res = await fetch(`${handle.url}/v1/memories/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(id);

    // Verify gone from DB.
    const db = openHippoDb(home);
    try {
      const row = db.prepare(`SELECT id FROM memories WHERE id = ?`).get(id);
      expect(row).toBeUndefined();
    } finally {
      closeHippoDb(db);
    }
  });

  it('DELETE /v1/memories/:id with unknown id returns 404', async () => {
    const res = await fetch(`${handle.url}/v1/memories/mem_does_not_exist`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it('POST /v1/memories/:id/promote copies to global store', async () => {
    const { id } = apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      { content: 'promote-canary-payload' },
    );
    const res = await fetch(`${handle.url}/v1/memories/${id}/promote`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sourceId: string; globalId: string };
    expect(body.ok).toBe(true);
    expect(body.sourceId).toBe(id);
    // promoteToGlobal mints a fresh id on the global store; prefix is 'g_'.
    expect(body.globalId).toMatch(/^g_/);
  });

  it('POST /v1/memories/:id/supersede chains old to new', async () => {
    const { id } = apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      { content: 'supersede-old-content' },
    );
    const res = await fetch(`${handle.url}/v1/memories/${id}/supersede`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'supersede-new-content' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; oldId: string; newId: string };
    expect(body.ok).toBe(true);
    expect(body.oldId).toBe(id);
    expect(body.newId).toMatch(/^mem_/);
    expect(body.newId).not.toBe(id);
  });

  it('POST /v1/memories/:id/archive archives a kind=raw row', async () => {
    // Seed a raw row directly: createMemory defaults to distilled, but
    // archiveRawMemory requires kind='raw'.
    const db = openHippoDb(home);
    let rawId: string;
    try {
      rawId = `mem_raw_http_${Math.random().toString(36).slice(2, 10)}`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO memories(
           id, created, last_retrieved, retrieval_count, strength, half_life_days, layer,
           tags_json, emotional_valence, schema_fit, source, outcome_score,
           outcome_positive, outcome_negative,
           conflicts_with_json, pinned, confidence, content,
           parents_json, starred,
           valid_from, kind, tenant_id, updated_at
         ) VALUES (?, ?, ?, 0, 0.5, 30, 'episodic',
                   '[]', 0, 0, 'manual', 0,
                   0, 0,
                   '[]', 0, 'verified', 'raw-http-canary',
                   '[]', 0,
                   ?, 'raw', 'default', datetime('now'))`,
      ).run(rawId, now, now, now);
    } finally {
      closeHippoDb(db);
    }

    const res = await fetch(`${handle.url}/v1/memories/${rawId}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'gdpr-http' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; archivedAt: string };
    expect(body.ok).toBe(true);
    expect(body.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const db2 = openHippoDb(home);
    try {
      const row = db2.prepare(`SELECT id FROM memories WHERE id = ?`).get(rawId);
      expect(row).toBeUndefined();
      const archived = db2
        .prepare(`SELECT memory_id, reason FROM raw_archive WHERE memory_id = ?`)
        .get(rawId) as { memory_id: string; reason: string } | undefined;
      expect(archived?.memory_id).toBe(rawId);
      expect(archived?.reason).toBe('gdpr-http');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('POST /v1/memories with invalid JSON body returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid json/i);
  });

  it('POST /v1/memories with missing content returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'distilled' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/content/i);
  });

  it('GET /v1/memories without q returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/memories`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/q is required/i);
  });
});
