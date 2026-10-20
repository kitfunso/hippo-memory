import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { remember as apiRemember } from '../../src/api/index.js';
import type { ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every call site below targets one of this file's routes under
  // test (POST/GET/DELETE /v1/memories, /v1/auth/keys, /v1/audit); each
  // response shape is checked field-by-field by the assertions immediately
  // following each call.
  return res.json() as Promise<T>;
}

describe('server HTTP routes — memories', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-routes');
    globalHome = makeRoot('srv-routes');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
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
    const body = await jsonAs<{ id: string; kind: string; tenantId: string }>(res);
    expect(body.id).toMatch(/^mem_/);
    expect(body.kind).toBe('distilled');
    expect(body.tenantId).toBe('default');
  });

  it('GET /v1/memories?q= returns matching results', async () => {
    await apiRemember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
      content: 'recall-via-http alpha-token-http sentinel',
    });
    await apiRemember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
      content: 'unrelated noise',
    });

    const res = await fetch(`${handle.url}/v1/memories?q=alpha-token-http&limit=5`);
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      results: Array<{ id: string; content: string; score: number }>;
      total: number;
      tokens: number;
    }>(res);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.content).toContain('alpha-token-http');
    expect(body.total).toBe(1);
    // estimateTokens is ceil(length / 4) over the one 41-char matching row.
    expect(body.tokens).toBe(11);
  });

  it('DELETE /v1/memories/:id removes the row', async () => {
    const { id } = await apiRemember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
      content: 'forget-canary-target',
    });
    const res = await fetch(`${handle.url}/v1/memories/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ ok: boolean; id: string }>(res);
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

  it('POST /v1/memories/:id/promote copies to global store', async () => {
    const { id } = await apiRemember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
      content: 'promote-canary-payload',
    });
    const res = await fetch(`${handle.url}/v1/memories/${id}/promote`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ ok: boolean; sourceId: string; globalId: string }>(res);
    expect(body.ok).toBe(true);
    expect(body.sourceId).toBe(id);
    // copyToGlobal mints a fresh id on the global store; prefix is 'g_'.
    expect(body.globalId).toMatch(/^g_/);
  });

  it('POST /v1/memories/:id/supersede chains old to new', async () => {
    const { id } = await apiRemember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
      content: 'supersede-old-content',
    });
    const res = await fetch(`${handle.url}/v1/memories/${id}/supersede`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'supersede-new-content' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ ok: boolean; oldId: string; newId: string }>(res);
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
    const body = await jsonAs<{ ok: boolean; archivedAt: string }>(res);
    expect(body.ok).toBe(true);
    expect(body.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const db2 = openHippoDb(home);
    try {
      const row = db2.prepare(`SELECT id FROM memories WHERE id = ?`).get(rawId);
      expect(row).toBeUndefined();
      // SAFETY: SELECT memory_id, reason FROM raw_archive WHERE memory_id = ?
      // names exactly those two columns against the row the /archive route
      // just wrote for rawId; may be undefined only if archiving silently
      // failed (checked by the assertions below).
      const archived = db2.prepare(`SELECT memory_id, reason FROM raw_archive WHERE memory_id = ?`).get(rawId) as
        | { memory_id: string; reason: string }
        | undefined;
      expect(archived?.memory_id).toBe(rawId);
      expect(archived?.reason).toBe('gdpr-http');
    } finally {
      closeHippoDb(db2);
    }
  });
});

describe('server HTTP routes — auth + audit', () => {
  let home: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-routes');
    vi.stubEnv('HIPPO_HOME', home);
    handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('POST /v1/auth/keys returns plaintext + keyId', async () => {
    const res = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'http-test-key' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ keyId: string; plaintext: string; tenantId: string }>(res);
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
    const k1 = await jsonAs<{ keyId: string }>(r1);
    const r2 = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'k2' }),
    });
    const k2 = await jsonAs<{ keyId: string }>(r2);
    await fetch(`${handle.url}/v1/auth/keys/${k2.keyId}`, { method: 'DELETE' });

    // Default (active=true): only k1.
    const activeRes = await fetch(`${handle.url}/v1/auth/keys`);
    expect(activeRes.status).toBe(200);
    const activeBody = await jsonAs<Array<{ keyId: string; revokedAt: string | null }>>(activeRes);
    const activeIds = activeBody.map((k) => k.keyId);
    expect(activeIds).toContain(k1.keyId);
    expect(activeIds).not.toContain(k2.keyId);

    // active=false: includes the revoked k2.
    const allRes = await fetch(`${handle.url}/v1/auth/keys?active=false`);
    expect(allRes.status).toBe(200);
    const allBody = await jsonAs<Array<{ keyId: string }>>(allRes);
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
    const minted = await jsonAs<{ keyId: string }>(mintRes);

    const first = await fetch(`${handle.url}/v1/auth/keys/${minted.keyId}`, { method: 'DELETE' });
    expect(first.status).toBe(200);
    const firstBody = await jsonAs<{ ok: boolean; revokedAt: string }>(first);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Second DELETE on the same id: authRevoke returns ok:true with the
    // existing revokedAt (idempotent), per src/api/index.ts authRevoke.
    const second = await fetch(`${handle.url}/v1/auth/keys/${minted.keyId}`, { method: 'DELETE' });
    expect(second.status).toBe(200);
    const secondBody = await jsonAs<{ ok: boolean; revokedAt: string }>(second);
    expect(secondBody.revokedAt).toBe(firstBody.revokedAt);

    // Unknown key_id → 404 (mapApiError sees "Unknown key_id: ..." and routes 404).
    const missing = await fetch(`${handle.url}/v1/auth/keys/hk_does_not_exist`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    const missingBody = await jsonAs<{ error: string }>(missing);
    expect(missingBody.error).toMatch(/unknown key_id/i);
  });

  it('GET /v1/audit returns events; filter by op works', async () => {
    // Generate at least one audit event by remembering through the API.
    await apiRemember(apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' }), {
      content: 'audit-canary-row',
    });

    const allRes = await fetch(`${handle.url}/v1/audit`);
    expect(allRes.status).toBe(200);
    const allBody = await jsonAs<Array<{ op: string; actor: string }>>(allRes);
    expect(allBody.map((e) => e.op)).toEqual(['remember']);

    const filteredRes = await fetch(`${handle.url}/v1/audit?op=remember&limit=5`);
    expect(filteredRes.status).toBe(200);
    const filteredBody = await jsonAs<Array<{ op: string }>>(filteredRes);
    expect(filteredBody.map((e) => e.op)).toEqual(['remember']);
  });

  it('GET /v1/audit with invalid since returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/audit?since=not-a-date`);
    expect(res.status).toBe(400);
    const body = await jsonAs<{ error: string }>(res);
    expect(body.error).toBe('since must be an ISO 8601 date');
    expect(body.error).not.toContain('not-a-date');
  });

  it('GET /v1/audit with out-of-range limit returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/audit?limit=99999999`);
    expect(res.status).toBe(400);
    const body = await jsonAs<{ error: string }>(res);
    expect(body.error).toMatch(/limit must be/i);
  });
});
