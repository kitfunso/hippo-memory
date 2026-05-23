/**
 * Runtime tests for POST /v1/outcome (Episode B, Task 2).
 *
 * Thin wrapper over api.outcome + api.outcomeForLastRecall:
 *   - body.ids provided  -> api.outcome(ctx, ids, good), returns {applied}
 *   - body.ids omitted   -> api.outcomeForLastRecall(ctx, good), returns {applied, ids}
 *
 * Coverage:
 *   - ids path (200)
 *   - last-recall path (200, ids in response)
 *   - no last recall (200, applied:0 + empty ids)
 *   - missing good (400)
 *   - non-boolean good (400)
 *   - ids not an array (400)
 *   - audit emission per applied id
 *   - cross-tenant id silently skipped (applied:0, zero audit rows)
 *
 * Real HTTP server (serve port:0), per-test isolated local + global stores.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initStore,
  loadIndex,
  saveIndex,
} from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { remember } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-srv-out-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('POST /v1/outcome', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = origHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('with ids returns applied:N (200)', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    const m1 = remember(ctx, { content: 'outcome-target-1' });
    const m2 = remember(ctx, { content: 'outcome-target-2' });

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [m1.id, m2.id], good: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number };
    expect(body.applied).toBe(2);
  });

  it('without ids uses last-recall (returns {applied, ids})', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    const m1 = remember(ctx, { content: 'last-recall-mem-1' });
    const m2 = remember(ctx, { content: 'last-recall-mem-2' });
    const idx = loadIndex(home);
    idx.last_retrieval_ids = [m1.id, m2.id];
    saveIndex(home, idx);

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ good: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; ids: string[] };
    expect(body.applied).toBe(2);
    expect(body.ids).toEqual([m1.id, m2.id]);
  });

  it('without ids and no last recall returns {applied:0, ids:[]}', async () => {
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ good: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; ids: string[] };
    expect(body).toEqual({ applied: 0, ids: [] });
  });

  it('missing good returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['mem_abc'] }),
    });
    expect(res.status).toBe(400);
  });

  it('non-boolean good returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ good: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it('ids not an array returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: 'not-an-array', good: true }),
    });
    expect(res.status).toBe(400);
  });

  it('emits one audit_log row per applied id (op=outcome)', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    const m1 = remember(ctx, { content: 'audit-trail-1' });
    const m2 = remember(ctx, { content: 'audit-trail-2' });

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [m1.id, m2.id], good: false }),
    });
    expect(res.status).toBe(200);

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'outcome' });
      expect(events.length).toBe(2);
      const targets = events.map((e) => e.targetId).sort();
      expect(targets).toEqual([m1.id, m2.id].sort());
    } finally {
      closeHippoDb(db);
    }
  });

  it('cross-tenant id silently skipped: applied:0, zero audit rows', async () => {
    // Memory belongs to tenant_b. Caller hits the route with no Bearer, so
    // ctx.tenantId resolves to 'default' (the unauthenticated localhost
    // default). default cannot read tenant_b's memory -> readEntry returns
    // null -> applied stays 0, no audit row written.
    const tenantBCtx = { hippoRoot: home, tenantId: 'tenant_b', actor: 'localhost:cli' };
    const tenantBMem = remember(tenantBCtx, { content: 'belongs-to-tenant-b' });

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [tenantBMem.id], good: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number };
    expect(body.applied).toBe(0);

    const db = openHippoDb(home);
    try {
      const eventsDefault = queryAuditEvents(db, { tenantId: 'default', op: 'outcome' });
      const eventsB = queryAuditEvents(db, { tenantId: 'tenant_b', op: 'outcome' });
      expect(eventsDefault.length).toBe(0);
      expect(eventsB.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('cross-tenant last-recall path: response ids field does NOT leak other-tenant ids', async () => {
    // Regression test for the v1.11.4 security fix.
    // Pre-fix: tenant_b POSTing {good:true} (no ids) would receive
    //   {applied:0, ids:[<tenant_a's mem_*>]} — tenant_a's memory ids
    //   surfaced verbatim to tenant_b through last_retrieval_ids (which
    //   is per-hippoRoot, not tenant-scoped at the index layer).
    // Post-fix: api.outcomeForLastRecall returns appliedIds (tenant-filtered)
    //   as the ids field, so non-applied (cross-tenant) ids are excluded.
    // This route hit has no Bearer, so ctx.tenantId = 'default'. We seed
    // last_retrieval_ids with a tenant_b memory id and verify the
    // 'default' caller cannot see it.
    const tenantBCtx = { hippoRoot: home, tenantId: 'tenant_b', actor: 'localhost:cli' };
    const tenantBMem = remember(tenantBCtx, { content: 'tenant-b-secret-id' });
    const idx = loadIndex(home);
    idx.last_retrieval_ids = [tenantBMem.id];
    saveIndex(home, idx);

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ good: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { applied: number; ids: string[] };
    expect(body.applied).toBe(0);
    // The critical assertion: response ids must NOT contain the
    // cross-tenant id. Pre-v1.11.4 this was [tenantBMem.id], leaking
    // tenant_b's memory id to the default caller.
    expect(body.ids).toEqual([]);
    expect(body.ids).not.toContain(tenantBMem.id);
  });
});
