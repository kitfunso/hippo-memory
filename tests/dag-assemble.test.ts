/**
 * Phase 2 — `api.assemble`. Bio-aware context engine.
 *
 * Builds a chronologically-ordered context window for a session: fresh-tail
 * raw rows + summary substitutions for older rows + budget-fit. Key
 * differentiator from lossless-claw: eviction picks lowest-strength
 * non-fresh-tail items first instead of oldest-first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadSessionRawMemories } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry, MemoryKind } from '../src/memory.js';
import { assemble, type Context } from '../src/api.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: 'test:assemble' };
}

function makeRaw(text: string, sessionId: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    source_session_id: sessionId,
    tags: opts.tags ?? [],
    dag_level: opts.dag_level ?? 0,
    dag_parent_id: opts.dag_parent_id,
  });
  if (opts.created) e.created = opts.created;
  if (opts.strength !== undefined) e.strength = opts.strength;
  return e;
}

function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const s = createMemory(text, {
    layer: Layer.Semantic,
    confidence: 'inferred',
    dag_level: 2,
    tags: ['dag-summary'],
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
  return s;
}

describe('loadSessionRawMemories', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('assemble-load'); });
  afterEach(() => safeRmSync(root));

  it('empty session id returns []', () => {
    expect(loadSessionRawMemories(root, '', 'default')).toEqual([]);
  });

  it('returns raws scoped to session, oldest first, tenant scoped', () => {
    const a = makeRaw('first message text', 'sess-a');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('second message text', 'sess-a');
    b.created = '2026-01-02T00:00:00.000Z';
    const c = makeRaw('third message text', 'sess-b');
    c.created = '2026-01-03T00:00:00.000Z';
    const d = makeRaw('other tenant content', 'sess-a', { tenantId: 'other' });
    d.created = '2026-01-04T00:00:00.000Z';
    [a, b, c, d].forEach((e) => writeEntry(root, e));
    const got = loadSessionRawMemories(root, 'sess-a', 'default');
    expect(got.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('excludes superseded rows', () => {
    const a = makeRaw('superseded content body', 'sess-x');
    a.superseded_by = 'mem_succ';
    writeEntry(root, a);
    expect(loadSessionRawMemories(root, 'sess-x', 'default')).toHaveLength(0);
  });
});

describe('api.assemble', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('assemble'); });
  afterEach(() => safeRmSync(root));

  it('1. empty session id returns clean empty result', () => {
    const r = assemble(ctxFor(root), '');
    expect(r.items).toEqual([]);
    expect(r.totalRaw).toBe(0);
    expect(r.tokens).toBe(0);
  });

  it('2. unknown session returns clean empty result', () => {
    const r = assemble(ctxFor(root), 'sess-no-such-thing');
    expect(r.items).toEqual([]);
  });

  it('3. all-tail case: rows fewer than freshTailCount stay verbatim', () => {
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`message ${i} content`, 'sess-t');
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = assemble(ctxFor(root), 'sess-t', { freshTailCount: 10 });
    expect(r.items.length).toBe(3);
    expect(r.items.every((it) => it.isFreshTail)).toBe(true);
    expect(r.summarized).toBe(0);
  });

  it('4. older raws under shared parent get substituted; tail kept raw', () => {
    const summary = makeSummary('topic alpha rollup');
    summary.descendant_count = 4;
    summary.earliest_at = '2026-01-01T00:00:00.000Z';
    summary.latest_at = '2026-01-04T00:00:00.000Z';
    writeEntry(root, summary);

    // 4 older raws under parent
    for (let i = 0; i < 4; i++) {
      const e = makeRaw(`older detail ${i}`, 'sess-s', {
        dag_level: 1,
        dag_parent_id: summary.id,
      });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    // 2 fresh-tail raws (no parent)
    for (let i = 0; i < 2; i++) {
      const e = makeRaw(`fresh tail row ${i}`, 'sess-s');
      e.created = `2026-01-1${i}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = assemble(ctxFor(root), 'sess-s', { freshTailCount: 2, budget: 100000 });
    const summaryItems = r.items.filter((it) => it.isSummary);
    const tailItems = r.items.filter((it) => it.isFreshTail);
    expect(summaryItems.length).toBe(1);
    expect(summaryItems[0].substitutedFor?.length).toBe(4);
    expect(tailItems.length).toBe(2);
    expect(r.summarized).toBe(4);
    expect(r.totalRaw).toBe(6);
  });

  it('5. budget-tight eviction picks lowest-strength non-fresh-tail item first', () => {
    // 1 strong older row + 1 weak older row + 1 tail row. Tight budget.
    const strongOld = makeRaw('strong older row content here', 'sess-b');
    strongOld.created = '2026-01-01T00:00:00.000Z';
    strongOld.strength = 5.0;

    const weakOld = makeRaw('weak older row content here', 'sess-b');
    weakOld.created = '2026-01-02T00:00:00.000Z';
    weakOld.strength = 0.5;

    const tail = makeRaw('tail row content here', 'sess-b');
    tail.created = '2026-01-03T00:00:00.000Z';
    tail.strength = 1.0;

    [strongOld, weakOld, tail].forEach((e) => writeEntry(root, e));

    // Tight budget that forces 1 eviction.
    const totalChars = strongOld.content.length + weakOld.content.length + tail.content.length;
    const budget = Math.ceil(totalChars / 4) - 5;

    const r = assemble(ctxFor(root), 'sess-b', { freshTailCount: 1, budget });
    expect(r.evicted).toBeGreaterThanOrEqual(1);
    // The evicted one is the weak older row, NOT strong old or tail.
    const ids = r.items.map((it) => it.id);
    expect(ids).toContain(strongOld.id);
    expect(ids).toContain(tail.id);
    expect(ids).not.toContain(weakOld.id);
  });

  it('6. tenant isolation: rows from another tenant are not loaded', () => {
    const e = makeRaw('cross tenant content', 'sess-x', { tenantId: 'other' });
    writeEntry(root, e);
    const r = assemble(ctxFor(root, 'default'), 'sess-x');
    expect(r.items).toEqual([]);
    expect(r.totalRaw).toBe(0);
  });

  it('7. private-scoped raws are filtered out', () => {
    const pub = makeRaw('public chatter row', 'sess-p', { scope: 'slack:public:Cgen' });
    pub.created = '2026-01-01T00:00:00.000Z';
    const priv = makeRaw('private payroll row', 'sess-p', { scope: 'slack:private:Csec' });
    priv.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, pub);
    writeEntry(root, priv);
    const r = assemble(ctxFor(root), 'sess-p');
    const ids = r.items.map((it) => it.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);
    expect(r.totalRaw).toBe(2);
  });

  it('8. summarizeOlder=false keeps every older raw as-is', () => {
    const summary = makeSummary('would have been used');
    writeEntry(root, summary);
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`older detail ${i}`, 'sess-no-sub', {
        dag_level: 1,
        dag_parent_id: summary.id,
      });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = assemble(ctxFor(root), 'sess-no-sub', {
      freshTailCount: 1,
      summarizeOlder: false,
      budget: 100000,
    });
    expect(r.summarized).toBe(0);
    expect(r.items.every((it) => !it.isSummary)).toBe(true);
    expect(r.items.length).toBe(3);
  });
});
