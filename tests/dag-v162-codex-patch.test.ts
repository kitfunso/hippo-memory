/**
 * v1.6.2 patch — covers the two functional bugs codex caught after v1.6.1:
 *
 *   #1 (regression in v1.6.1): loadSessionRawMemories with cap returned
 *      the OLDEST `cap` rows (ORDER BY ASC LIMIT). For a session with
 *      >cap raws, the newest rows were dropped and the "fresh tail"
 *      protection silently failed. Now loads NEWEST `cap` rows and
 *      reverses to chronological order.
 *
 *   #2 (pre-existing in v1.5.2): loadFreshRawMemories was tenant-wide
 *      only. Multi-session tenants surfaced cross-session rows tagged
 *      isFreshTail=true. Now accepts an optional sessionId; RecallOpts
 *      gains freshTailSessionId for callers who want the correct shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadSessionRawMemories, loadFreshRawMemories } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry, MemoryKind } from '../src/memory.js';
import { recall, assemble, type Context } from '../src/api.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: 'test:v162' };
}
function makeRaw(text: string, sessionId: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    source_session_id: sessionId,
  });
  if (opts.created) e.created = opts.created;
  return e;
}

describe('v1.6.2 codex P2 #1 — loadSessionRawMemories cap preserves NEWEST rows', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('v162-cap'); });
  afterEach(() => safeRmSync(root));

  it('cap=3 on 10-row session returns the NEWEST 3 (oldest-first within window)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const e = makeRaw(`message body row number ${i}`, 'sess-x');
      e.created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
      ids.push(e.id);
    }
    const got = loadSessionRawMemories(root, 'sess-x', 'default', 3);
    expect(got.length).toBe(3);
    // Pre-v1.6.2 returned ids[0..2]; v1.6.2 returns ids[7..9] in oldest-first order.
    expect(got.map((e) => e.id)).toEqual([ids[7], ids[8], ids[9]]);
  });

  it('assemble with rowCap on a long session protects fresh-tail correctly', () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const e = makeRaw(`session msg ${i} content body`, 'sess-y');
      e.created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
      ids.push(e.id);
    }
    const r = assemble(ctxFor(root), 'sess-y', { rowCap: 5, freshTailCount: 3, budget: 100000 });
    expect(r.truncated).toBe(true);
    // Pre-v1.6.2: items would be ids[0..4] (oldest), and freshTailCount=3 would
    // mark ids[2..4] as fresh-tail — actually stale relative to ids[9..11].
    // v1.6.2: items are ids[7..11] (newest 5), fresh-tail = ids[9..11].
    const itemIds = r.items.map((it) => it.id);
    expect(itemIds).toContain(ids[11]);
    expect(itemIds).toContain(ids[10]);
    expect(itemIds).toContain(ids[9]);
    expect(itemIds).not.toContain(ids[0]);
    const tailIds = r.items.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(new Set(tailIds)).toEqual(new Set([ids[9], ids[10], ids[11]]));
  });
});

describe('v1.6.2 codex P2 #2 — loadFreshRawMemories sessionId scope', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('v162-sess'); });
  afterEach(() => safeRmSync(root));

  it('without sessionId: tenant-wide (legacy v1.5.2 behaviour)', () => {
    const a = makeRaw('row in session A', 'sess-A');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row in session B', 'sess-B');
    b.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, a);
    writeEntry(root, b);
    const got = loadFreshRawMemories(root, 5, 'default');
    const ids = got.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('with sessionId: only that session surfaces', () => {
    const a = makeRaw('row in session A', 'sess-A');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row in session B', 'sess-B');
    b.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, a);
    writeEntry(root, b);
    const got = loadFreshRawMemories(root, 5, 'default', 'sess-A');
    expect(got.map((e) => e.id)).toEqual([a.id]);
  });

  it('recall with freshTailSessionId scopes the fresh-tail to that session', () => {
    // Two concurrent sessions; the cross-session row must NOT be marked
    // isFreshTail when the caller scopes to sess-A.
    const a = makeRaw('row in session A query', 'sess-A');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row in session B query', 'sess-B');
    b.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, a);
    writeEntry(root, b);
    const r = recall(ctxFor(root), {
      query: 'totally unmatched query string',
      freshTailCount: 5,
      freshTailSessionId: 'sess-A',
    });
    const tailIds = r.results.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(tailIds).toContain(a.id);
    expect(tailIds).not.toContain(b.id);
  });

  it('recall WITHOUT freshTailSessionId is tenant-wide (legacy)', () => {
    const a = makeRaw('row in session A query', 'sess-A');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row in session B query', 'sess-B');
    b.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, a);
    writeEntry(root, b);
    const r = recall(ctxFor(root), {
      query: 'totally unmatched query string',
      freshTailCount: 5,
    });
    const tailIds = r.results.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(tailIds).toContain(a.id);
    expect(tailIds).toContain(b.id);
  });
});

describe('v1.6.2 codex P2 #3 — HTTP /v1/memories accepts new RecallOpts', () => {
  // Codex round 2 caught that pre-v1.6.2 the HTTP recall route silently
  // ignored freshTailCount, freshTailSessionId, and summarizeOverflow. They
  // were JS-API-only. Now wired through query params.
  let root: string;
  let serverHandle: { url: string; stop: () => Promise<void> };
  beforeEach(async () => {
    root = makeRoot('v162-http');
    const a = makeRaw('row in session A http', 'sess-Ah');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row in session B http', 'sess-Bh');
    b.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, a);
    writeEntry(root, b);
    const { serve } = await import('../src/server.js');
    serverHandle = await serve({ hippoRoot: root, port: 0 });
  });
  afterEach(async () => {
    await serverHandle.stop();
    safeRmSync(root);
  });

  it('fresh_tail_session_id query param scopes fresh-tail correctly', async () => {
    const res = await fetch(`${serverHandle.url}/v1/memories?q=unmatched&fresh_tail_count=5&fresh_tail_session_id=sess-Ah`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ content: string; isFreshTail?: boolean }> };
    const tail = body.results.filter((it) => it.isFreshTail);
    expect(tail.some((it) => it.content === 'row in session A http')).toBe(true);
    expect(tail.every((it) => it.content !== 'row in session B http')).toBe(true);
  });

  it('400 on bad fresh_tail_count', async () => {
    const res = await fetch(`${serverHandle.url}/v1/memories?q=unmatched&fresh_tail_count=-1`);
    expect(res.status).toBe(400);
  });
});
