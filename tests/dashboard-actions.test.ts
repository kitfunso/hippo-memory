// The four dashboard writes (pin, wrong, resolve, forget): their result mapping, tenant and live-only guards, and the request guards in front of them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { listMemoryConflicts, readEntry, replaceDetectedConflicts } from '../src/store.js';
import { quarantineScopeFor } from '../src/quarantine.js';
import type { MemoryDetail, ResolveResult } from '../src/dashboard-types.js';
import {
  NOW, call, get, isoAgo, makeStore, parse, postJson, seed, startDashboard, type RunningDashboard, type TmpStore,
} from './_helpers/dashboard-fixture.js';

const AT_RISK = { half_life_days: 10, created: isoAgo(0), last_retrieved: isoAgo(0) } as const;

let store: TmpStore;
let dash: RunningDashboard;

beforeEach(async () => {
  store = makeStore('hippo-dash-actions');
  dash = await startDashboard(store.hippoRoot, () => NOW);
});

afterEach(async () => {
  await dash.close();
  store.cleanup();
});

const row = (id: string) => readEntry(store.hippoRoot, id)!;

function openConflict(aId: string, bId: string, reason: string, tenantId = 'default'): number {
  replaceDetectedConflicts(store.hippoRoot, [{ memory_a_id: aId, memory_b_id: bId, reason, score: 0.9 }]);
  return listMemoryConflicts(store.hippoRoot, '*', tenantId).find((c) => c.reason === reason)!.id;
}

function lastAudit(): { actor: string; op: string } {
  const db = openHippoDb(store.hippoRoot);
  try {
    // SAFETY: the SELECT names the two audit_log columns of the cast shape.
    return db.prepare('SELECT actor, op FROM audit_log ORDER BY id DESC LIMIT 1').get() as { actor: string; op: string };
  } finally {
    closeHippoDb(db);
  }
}

describe('pin', () => {
  it('persists, flips the band both ways, and records the dashboard as the actor', async () => {
    const target = seed(store.hippoRoot, 'decaying fast', AT_RISK);

    const pinned = await postJson(dash.port, `/api/memory/${target.id}/pin`, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(parse<MemoryDetail>(pinned).band).toBe('pinned');
    expect(row(target.id).pinned).toBe(true);
    expect(lastAudit().actor).toBe('dashboard');

    const unpinned = await postJson(dash.port, `/api/memory/${target.id}/pin`, { pinned: false });
    expect(parse<MemoryDetail>(unpinned).band).toBe('atRisk');
    expect(row(target.id).pinned).toBe(false);
  });

  it('answers 400 for a body that is not {"pinned": boolean}', async () => {
    const target = seed(store.hippoRoot, 'a row');
    for (const payload of [{}, { pinned: 'yes' }, [], 'true']) {
      expect((await postJson(dash.port, `/api/memory/${target.id}/pin`, payload)).status).toBe(400);
    }
  });
});

describe('mark wrong', () => {
  it('raises outcome_negative once and returns the detail', async () => {
    const target = seed(store.hippoRoot, 'a doubtful row');

    const reply = await postJson(dash.port, `/api/memory/${target.id}/wrong`);

    expect(reply.status).toBe(200);
    expect(parse<MemoryDetail>(reply).wrong).toBe(true);
    expect(row(target.id).outcome_negative).toBe(1);
    expect(lastAudit()).toEqual({ actor: 'dashboard', op: 'outcome' });
  });
});

describe('resolve conflict', () => {
  it('keeps the winner, halves the loser half-life and marks the conflict resolved', async () => {
    const keep = seed(store.hippoRoot, 'deploy target is fly');
    const lose = seed(store.hippoRoot, 'deploy target is render');
    const id = openConflict(keep.id, lose.id, 'deploy target');

    const reply = await postJson(dash.port, `/api/conflicts/${id}/resolve`, { keep: keep.id });

    expect(reply.status).toBe(200);
    expect(parse<ResolveResult>(reply)).toEqual({ ok: true, conflictId: id, keptId: keep.id, weakenedId: lose.id });
    expect(row(keep.id).half_life_days).toBe(keep.half_life_days);
    expect(row(lose.id).half_life_days).toBe(lose.half_life_days / 2);
    expect(listMemoryConflicts(store.hippoRoot, '*', 'default')[0].status).toBe('resolved');
  });

  it('answers 409 for a resolved conflict, 400 for a keep outside the pair, 404 for a missing one', async () => {
    const a = seed(store.hippoRoot, 'claim a');
    const b = seed(store.hippoRoot, 'claim b');
    const other = seed(store.hippoRoot, 'claim c');
    const id = openConflict(a.id, b.id, 'a versus b');

    const outside = await postJson(dash.port, `/api/conflicts/${id}/resolve`, { keep: other.id });
    expect(outside.status).toBe(400);
    expect(row(b.id).half_life_days).toBe(b.half_life_days);

    expect((await postJson(dash.port, `/api/conflicts/${id}/resolve`, { keep: a.id })).status).toBe(200);
    const again = await postJson(dash.port, `/api/conflicts/${id}/resolve`, { keep: a.id });
    expect(again.status).toBe(409);
    expect(parse<{ error: string }>(again).error).toBe('This conflict is already resolved');

    expect((await postJson(dash.port, '/api/conflicts/9999/resolve', { keep: a.id })).status).toBe(404);
    expect((await postJson(dash.port, '/api/conflicts/0/resolve', { keep: a.id })).status).toBe(400);
  });
});

describe('forget', () => {
  it('deletes a distilled memory', async () => {
    const target = seed(store.hippoRoot, 'forget me');

    const reply = await postJson(dash.port, `/api/memory/${target.id}/forget`);

    expect(reply.status).toBe(200);
    expect(readEntry(store.hippoRoot, target.id)).toBeNull();
  });

  it('answers 409 with the archive hint for a raw receipt and keeps the row', async () => {
    const target = seed(store.hippoRoot, 'a raw receipt', { kind: 'raw' });

    const reply = await postJson(dash.port, `/api/memory/${target.id}/forget`);

    expect(reply.status).toBe(409);
    expect(parse<{ error: string }>(reply).error).toContain(`hippo forget ${target.id} --archive --reason`);
    expect(readEntry(store.hippoRoot, target.id)).not.toBeNull();
  });
});

describe('another tenant and not-live rows', () => {
  it('answers 404 and changes nothing for every action on another tenant id', async () => {
    const foreign = seed(store.hippoRoot, 'tenant b row', { tenantId: 'tenant_b' });
    const foreign2 = seed(store.hippoRoot, 'tenant b other row', { tenantId: 'tenant_b' });
    const conflictId = openConflict(foreign.id, foreign2.id, 'tenant b conflict', 'tenant_b');

    expect((await get(dash.port, `/api/memory/${foreign.id}`)).status).toBe(404);
    expect((await postJson(dash.port, `/api/memory/${foreign.id}/pin`, { pinned: true })).status).toBe(404);
    expect((await postJson(dash.port, `/api/memory/${foreign.id}/wrong`)).status).toBe(404);
    expect((await postJson(dash.port, `/api/memory/${foreign.id}/forget`)).status).toBe(404);
    expect((await postJson(dash.port, `/api/conflicts/${conflictId}/resolve`, { keep: foreign.id })).status).toBe(404);

    const after = row(foreign.id);
    expect(after.pinned).toBe(false);
    expect(after.outcome_negative).toBe(0);
    expect(after.half_life_days).toBe(foreign.half_life_days);
  });

  it('answers 404 and changes nothing on a quarantined and on a superseded id', async () => {
    const successor = seed(store.hippoRoot, 'the replacement');
    const quarantined = seed(store.hippoRoot, 'pending review', { scope: quarantineScopeFor(null) });
    const superseded = seed(store.hippoRoot, 'replaced', { kind: 'superseded', superseded_by: successor.id });

    for (const target of [quarantined, superseded]) {
      expect((await get(dash.port, `/api/memory/${target.id}`)).status).toBe(404);
      expect((await postJson(dash.port, `/api/memory/${target.id}/pin`, { pinned: true })).status).toBe(404);
      expect((await postJson(dash.port, `/api/memory/${target.id}/wrong`)).status).toBe(404);
      expect((await postJson(dash.port, `/api/memory/${target.id}/forget`)).status).toBe(404);
      const after = row(target.id);
      expect(after.pinned).toBe(false);
      expect(after.outcome_negative).toBe(0);
    }
  });

  it('hides a quarantined conflict partner from the detail and refuses to resolve it', async () => {
    const live = seed(store.hippoRoot, 'visible claim');
    const secret = seed(store.hippoRoot, 'hidden quarantined claim', { scope: quarantineScopeFor(null) });
    const id = openConflict(live.id, secret.id, 'with a quarantined member');

    const detail = await get(dash.port, `/api/memory/${live.id}`);
    expect(detail.status).toBe(200);
    expect(parse<MemoryDetail>(detail).conflicts).toEqual([]);
    expect(detail.body).not.toContain('hidden quarantined claim');

    expect((await postJson(dash.port, `/api/conflicts/${id}/resolve`, { keep: live.id })).status).toBe(404);
    expect(row(live.id).half_life_days).toBe(live.half_life_days);
    expect(row(secret.id).half_life_days).toBe(secret.half_life_days);
  });
});

describe('request guards', () => {
  it('answers 403 for a cross-site POST and for a non-loopback Host, and writes nothing', async () => {
    const target = seed(store.hippoRoot, 'guarded row');
    const path = `/api/memory/${target.id}/forget`;

    const crossSite = await postJson(dash.port, path, {}, { Origin: 'http://evil.example' });
    const foreignHost = await postJson(dash.port, path, {}, { Host: `evil.example:${dash.port}` });

    expect(crossSite.status).toBe(403);
    expect(foreignHost.status).toBe(403);
    expect(readEntry(store.hippoRoot, target.id)).not.toBeNull();
  });

  it('answers 415 for text/plain and for no content type, and the row survives', async () => {
    const target = seed(store.hippoRoot, 'content type row');
    const path = `/api/memory/${target.id}/forget`;

    const plain = await call(dash.port, 'POST', path, { headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    const none = await call(dash.port, 'POST', path, { body: '{}' });

    expect(plain.status).toBe(415);
    expect(none.status).toBe(415);
    expect(readEntry(store.hippoRoot, target.id)).not.toBeNull();
  });

  it('answers 400 for an oversized body and for malformed JSON', async () => {
    const target = seed(store.hippoRoot, 'body row');
    const path = `/api/memory/${target.id}/pin`;
    const json = { 'Content-Type': 'application/json' };

    const big = await call(dash.port, 'POST', path, { headers: json, body: JSON.stringify({ pinned: true, pad: 'x'.repeat(5_000) }) });
    const broken = await call(dash.port, 'POST', path, { headers: json, body: '{"pinned": tru' });

    expect(big.status).toBe(400);
    expect(broken.status).toBe(400);
    expect(row(target.id).pinned).toBe(false);
  });

  it('answers 400 for a malformed percent sequence in a path, and keeps serving', async () => {
    expect((await get(dash.port, '/api/memory/%E0%A4%A')).status).toBe(400);
    expect((await postJson(dash.port, '/api/memory/%E0%A4%A/pin', { pinned: true })).status).toBe(400);
    expect((await get(dash.port, '/api/overview')).status).toBe(200);
  });
});
