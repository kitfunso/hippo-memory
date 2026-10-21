// POST /v1/outcome over a real server: with ids it applies to them; without, to the ids this client last recalled over
// REST, so one client's outcome never lands on another's recall.

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { remember } from '../../src/api/index.js';
import type { ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadLastRecall, readEntry, saveIndex } from '../_helpers/root-forms.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** POST /v1/outcome with no ids as `bearer`, or keyless, so it lands on that caller's last recall. */
async function postOutcome(url: string, body: { readonly good: boolean }, bearer?: string): Promise<Response> {
  const auth: Record<string, string> = bearer === undefined ? {} : { authorization: `Bearer ${bearer}` };
  return fetch(`${url}/v1/outcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
}

/** The ids a REST recall for `q` showed `bearer`, or a keyless caller. */
async function recalledIds(url: string, q: string, bearer?: string): Promise<string[]> {
  const headers: Record<string, string> = bearer === undefined ? {} : { authorization: `Bearer ${bearer}` };
  const res = await fetch(`${url}/v1/memories?q=${encodeURIComponent(q)}`, { headers });
  expect(res.status).toBe(200);
  return (await jsonAs<{ results: { id: string }[] }>(res)).results.map((r) => r.id);
}

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every call site below targets POST /v1/outcome under test in
  // this file; the response shape is checked field-by-field by the
  // assertions immediately following each call.
  return res.json() as Promise<T>;
}

describe('POST /v1/outcome', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-out');
    globalHome = makeRoot('srv-out');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it.skipIf(needsHippoDb('db'))('with ids returns applied:N (200)', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    const m1 = await remember(ctx, { content: 'outcome-target-1' });
    const m2 = await remember(ctx, { content: 'outcome-target-2' });

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [m1.id, m2.id], good: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ applied: number }>(res);
    expect(body.applied).toBe(2);
  });

  it.skipIf(needsHippoDb('db'))(
    'without ids applies to what this client last recalled (returns {applied, ids})',
    async () => {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
      const m1 = await remember(ctx, { content: 'zebrafish feeding schedule one' });
      const m2 = await remember(ctx, { content: 'zebrafish feeding schedule two' });
      const shown = await recalledIds(handle.url, 'zebrafish');
      expect([...shown].sort()).toEqual([m1.id, m2.id].sort());

      const res = await postOutcome(handle.url, { good: true });
      expect(res.status).toBe(200);
      expect(await jsonAs<{ applied: number; ids: string[] }>(res)).toEqual({ applied: 2, ids: shown });
    },
  );

  it("without ids ignores the store's CLI last recall", async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    const m1 = await remember(ctx, { content: 'cli-last-recall-mem' });
    const idx = loadLastRecall(home);
    idx.last_retrieval_ids = [m1.id];
    saveIndex(home, idx);

    const res = await postOutcome(handle.url, { good: true });
    expect(await jsonAs<{ applied: number; ids: string[] }>(res)).toEqual({ applied: 0, ids: [] });
  });

  it('without ids and no last recall returns {applied:0, ids:[]}', async () => {
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ good: false }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ applied: number; ids: string[] }>(res);
    expect(body).toEqual({ applied: 0, ids: [] });
  });

  it('non-boolean good returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ good: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it.skipIf(needsHippoDb('db'))('emits one audit_log row per applied id (op=outcome)', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    const m1 = await remember(ctx, { content: 'audit-trail-1' });
    const m2 = await remember(ctx, { content: 'audit-trail-2' });

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
    const tenantBCtx: FullContext = apiCtx(home, 'tenant_b', { subject: 'localhost:cli', role: 'admin' });
    const tenantBMem = await remember(tenantBCtx, { content: 'belongs-to-tenant-b' });

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [tenantBMem.id], good: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ applied: number }>(res);
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
    // v1.11.4 regression: the store's last_retrieval_ids is per folder, not per tenant, so it must never answer a
    // keyless 'default' caller with a tenant_b id.
    const tenantBCtx: FullContext = apiCtx(home, 'tenant_b', { subject: 'localhost:cli', role: 'admin' });
    const tenantBMem = await remember(tenantBCtx, { content: 'tenant-b-secret-id' });
    const idx = loadLastRecall(home);
    idx.last_retrieval_ids = [tenantBMem.id];
    saveIndex(home, idx);

    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ good: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ applied: number; ids: string[] }>(res);
    expect(body.applied).toBe(0);
    // The critical assertion: response ids must NOT contain the
    // cross-tenant id. Pre-v1.11.4 this was [tenantBMem.id], leaking
    // tenant_b's memory id to the default caller.
    expect(body.ids).toEqual([]);
    expect(body.ids).not.toContain(tenantBMem.id);
  });

  // v1.11.5: DoS caps + body-cap interaction
  it('1001 ids returns 400 with cap-exceeded message', async () => {
    const ids = Array(1001)
      .fill(0)
      .map((_, i) => `mem_fake_${i}`);
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, good: true }),
    });
    expect(res.status).toBe(400);
    const body = await jsonAs<{ error: string }>(res);
    expect(body.error).toContain('1000-id cap');
  });

  it.skipIf(needsHippoDb('db'))('1000 ids at boundary returns 200 (cap-exclusive)', async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    // Seed 3 real memories so applied > 0 confirms route ran.
    const m1 = await remember(ctx, { content: 'boundary-mem-1' });
    const m2 = await remember(ctx, { content: 'boundary-mem-2' });
    const m3 = await remember(ctx, { content: 'boundary-mem-3' });
    // Pad with fake ids that will silently miss (still within cap).
    const ids = [
      m1.id,
      m2.id,
      m3.id,
      ...Array(997)
        .fill(0)
        .map((_, i) => `mem_pad_${i}`),
    ];
    expect(ids.length).toBe(1000);
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, good: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ applied: number }>(res);
    expect(body.applied).toBe(3); // only the 3 real ids applied
  });

  it('1MB+ body returns 413 from body cap before id cap fires', async () => {
    // Synthesise ~1.2MB of ids — body cap (1MB) at the HTTP layer fires
    // before our id cap (1000) at the route layer. Locks ordering: body
    // cap < id cap, attack vectors can't slip through by sending huge
    // payloads with <=1000 ids. BodyTooLargeError returns HTTP 413
    // (Payload Too Large), distinct from the route-level 400.
    const giantIds = Array(50000)
      .fill(0)
      .map((_, i) => `mem_giant_${i.toString().padStart(20, '0')}`);
    const payload = JSON.stringify({ ids: giantIds, good: true });
    expect(payload.length).toBeGreaterThan(1_000_000);
    const res = await fetch(`${handle.url}/v1/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /v1/outcome without ids, one client beside another', () => {
  let home: string;
  let globalHome: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('srv-out-clients');
    globalHome = makeRoot('srv-out-clients');
    vi.stubEnv('HIPPO_HOME', globalHome);
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  const memberKey = (label: string): string => {
    const db = openHippoDb(home);
    try {
      return createApiKey(db, { tenantId: 'default', label, role: 'member' }).plaintext;
    } finally {
      closeHippoDb(db);
    }
  };

  it.skipIf(needsHippoDb('db'))("lands on the ids each client last recalled, never on another client's", async () => {
    const ctx: FullContext = apiCtx(home, 'default', { subject: 'localhost:cli', role: 'admin' });
    const zebra = await remember(ctx, { content: 'zebrafish feeding schedule' });
    const quokka = await remember(ctx, { content: 'quokka habitat survey' });
    const [a, b, idle] = [memberKey('a'), memberKey('b'), memberKey('idle')];
    expect(await recalledIds(handle.url, 'zebrafish', a)).toEqual([zebra.id]);
    expect(await recalledIds(handle.url, 'quokka', b)).toEqual([quokka.id]);

    const outA = await postOutcome(handle.url, { good: true }, a);
    const outB = await postOutcome(handle.url, { good: false }, b);
    const outIdle = await postOutcome(handle.url, { good: true }, idle);
    expect(await jsonAs<{ ids: string[] }>(outA)).toEqual({ applied: 1, ids: [zebra.id] });
    expect(await jsonAs<{ ids: string[] }>(outB)).toEqual({ applied: 1, ids: [quokka.id] });
    expect(await jsonAs<{ ids: string[] }>(outIdle)).toEqual({ applied: 0, ids: [] });
    expect(readEntry(home, zebra.id)).toMatchObject({ outcomePositive: 1, outcomeNegative: 0 });
    expect(readEntry(home, quokka.id)).toMatchObject({ outcomePositive: 0, outcomeNegative: 1 });
  });
});
