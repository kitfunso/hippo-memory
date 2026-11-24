import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serveKeyed } from '../_helpers/keyed-server.js';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { retrieve, assemble } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadSessionRawMemories, loadFreshRawMemories, writeEntry } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
  }
}
function ctxFor(root: string, tenantId: string = 'default'): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:v162', role: 'admin' });
}
function makeRaw(text: string, sessionId: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    sourceSessionId: sessionId,
  });
  if (opts.created) e.created = opts.created;
  return e;
}

describe('loadSessionRawMemories cap preserves NEWEST rows', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('v162-cap');
  });
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
    expect(got.map((e) => e.id)).toEqual([ids[7], ids[8], ids[9]]);
  });

  it('assemble with rowCap on a long session protects fresh-tail correctly', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const e = makeRaw(`session msg ${i} content body`, 'sess-y');
      e.created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
      ids.push(e.id);
    }
    const r = await assemble(ctxFor(root), 'sess-y', { rowCap: 5, freshTailCount: 3, budget: 100000 });
    expect(r.truncated).toBe(true);
    const itemIds = r.items.map((it) => it.id);
    expect(itemIds).toContain(ids[11]);
    expect(itemIds).toContain(ids[10]);
    expect(itemIds).toContain(ids[9]);
    expect(itemIds).not.toContain(ids[0]);
    const tailIds = r.items.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(new Set(tailIds)).toEqual(new Set([ids[9], ids[10], ids[11]]));
  });
});

describe('loadFreshRawMemories sessionId scope', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('v162-sess');
  });
  afterEach(() => safeRmSync(root));

  it('without sessionId: tenant-wide (legacy behaviour)', () => {
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

  it('recall with freshTailSessionId scopes the fresh-tail to that session', async () => {
    const a = makeRaw('row in session A query', 'sess-A');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row in session B query', 'sess-B');
    b.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, a);
    writeEntry(root, b);
    const r = await retrieve(ctxFor(root), {
      query: 'totally unmatched query string',
      window: { freshTailCount: 5, freshTailSessionId: 'sess-A' },
    });
    const tailIds = r.results.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(tailIds).toContain(a.id);
    expect(tailIds).not.toContain(b.id);
  });

  it('recall WITHOUT freshTailSessionId is tenant-wide (legacy)', async () => {
    const a = makeRaw('row in session A query', 'sess-A');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row in session B query', 'sess-B');
    b.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, a);
    writeEntry(root, b);
    const r = await retrieve(ctxFor(root), {
      query: 'totally unmatched query string',
      window: { freshTailCount: 5 },
    });
    const tailIds = r.results.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(tailIds).toContain(a.id);
    expect(tailIds).toContain(b.id);
  });
});

describe('HTTP /v1/memories accepts new RecallOptions', () => {
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
    serverHandle = await serveKeyed({ hippoRoot: root, port: 0 });
  });
  afterEach(async () => {
    await serverHandle.stop();
    safeRmSync(root);
  });

  it('fresh_tail_session_id query param scopes fresh-tail correctly', async () => {
    const res = await fetch(
      `${serverHandle.url}/v1/memories?q=unmatched&fresh_tail_count=5&fresh_tail_session_id=sess-Ah`,
    );
    expect(res.status).toBe(200);
    // SAFETY: /v1/memories route under test always responds with a RecallResult JSON body
    // whose results carry content and isFreshTail per the recall contract.
    const body = (await res.json()) as { results: Array<{ content: string; isFreshTail?: boolean }> };
    const tail = body.results.filter((it) => it.isFreshTail);
    expect(tail.some((it) => it.content === 'row in session A http')).toBe(true);
    expect(tail.every((it) => it.content !== 'row in session B http')).toBe(true);
  });

  it('400 on bad fresh_tail_count', async () => {
    const res = await fetch(`${serverHandle.url}/v1/memories?q=unmatched&fresh_tail_count=-1`);
    expect(res.status).toBe(400);
  });
});
