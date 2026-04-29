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

describe('server HTTP routes — auth + audit', () => {
  let home: string;
  let originalHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
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
  });

  it('POST /v1/auth/keys returns plaintext + keyId', async () => {
    const res = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'http-test-key' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { keyId: string; plaintext: string; tenantId: string };
    expect(body.keyId).toMatch(/^hk_/);
    // Plaintext is the only place a caller will ever see the raw secret —
    // ensure it actually lands in the JSON response (not just the keyId).
    expect(body.plaintext).toMatch(/^hk_/);
    expect(body.plaintext.length).toBeGreaterThan(body.keyId.length);
    expect(body.tenantId).toBe('default');
  });

  it('GET /v1/auth/keys defaults to active=true; ?active=false includes revoked', async () => {
    // Mint two keys, revoke one.
    const r1 = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'k1' }),
    });
    const k1 = await r1.json() as { keyId: string };
    const r2 = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'k2' }),
    });
    const k2 = await r2.json() as { keyId: string };
    await fetch(`${handle.url}/v1/auth/keys/${k2.keyId}`, { method: 'DELETE' });

    // Default (active=true): only k1.
    const activeRes = await fetch(`${handle.url}/v1/auth/keys`);
    expect(activeRes.status).toBe(200);
    const activeBody = await activeRes.json() as Array<{ keyId: string; revokedAt: string | null }>;
    const activeIds = activeBody.map((k) => k.keyId);
    expect(activeIds).toContain(k1.keyId);
    expect(activeIds).not.toContain(k2.keyId);

    // active=false: includes the revoked k2.
    const allRes = await fetch(`${handle.url}/v1/auth/keys?active=false`);
    expect(allRes.status).toBe(200);
    const allBody = await allRes.json() as Array<{ keyId: string }>;
    const allIds = allBody.map((k) => k.keyId);
    expect(allIds).toContain(k1.keyId);
    expect(allIds).toContain(k2.keyId);
  });

  it('DELETE /v1/auth/keys/:keyId revokes; second DELETE returns 200 (already revoked) idempotent path or 404 on unknown', async () => {
    const mintRes = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'revoke-target' }),
    });
    const minted = await mintRes.json() as { keyId: string };

    const first = await fetch(`${handle.url}/v1/auth/keys/${minted.keyId}`, { method: 'DELETE' });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { ok: boolean; revokedAt: string };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Second DELETE on the same id: authRevoke returns ok:true with the
    // existing revokedAt (idempotent), per src/api.ts authRevoke.
    const second = await fetch(`${handle.url}/v1/auth/keys/${minted.keyId}`, { method: 'DELETE' });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { ok: boolean; revokedAt: string };
    expect(secondBody.revokedAt).toBe(firstBody.revokedAt);

    // Unknown key_id → 404 (mapApiError sees "Unknown key_id: ..." and routes 404).
    const missing = await fetch(`${handle.url}/v1/auth/keys/hk_does_not_exist`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    const missingBody = await missing.json() as { error: string };
    expect(missingBody.error).toMatch(/unknown key_id/i);
  });

  it('GET /v1/audit returns events; filter by op works', async () => {
    // Generate at least one audit event by remembering through the API.
    apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      { content: 'audit-canary-row' },
    );

    const allRes = await fetch(`${handle.url}/v1/audit`);
    expect(allRes.status).toBe(200);
    const allBody = await allRes.json() as Array<{ op: string; actor: string }>;
    expect(allBody.length).toBeGreaterThan(0);
    expect(allBody.some((e) => e.op === 'remember')).toBe(true);

    const filteredRes = await fetch(`${handle.url}/v1/audit?op=remember&limit=5`);
    expect(filteredRes.status).toBe(200);
    const filteredBody = await filteredRes.json() as Array<{ op: string }>;
    expect(filteredBody.length).toBeGreaterThan(0);
    expect(filteredBody.every((e) => e.op === 'remember')).toBe(true);
  });

  it('GET /v1/audit with invalid op returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/audit?op=not_a_real_op`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid op/i);
  });

  it('GET /v1/audit with invalid since returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/audit?since=not-a-date`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid since/i);
  });

  it('GET /v1/audit with out-of-range limit returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/audit?limit=99999999`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/limit must be/i);
  });
});
