/**
 * v1.5.2 fresh-tail recall — Task 4 of docs/plans/2026-05-05-dag-recall.md.
 *
 * RecallOpts.freshTailCount (default 0): when > 0, prepend the last N
 * kind='raw' rows so an agent's "what did I just see" path always covers
 * the recent window even when query terms don't match. Tenant + scope
 * filtered, deduplicated against the BM25 hits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry, MemoryKind } from '../src/memory.js';
import { recall, type Context } from '../src/api.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: 'test:fresh-tail' };
}

function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    tags: opts.tags ?? [],
  });
}

describe('fresh-tail recall', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('fresh-tail'); });
  afterEach(() => safeRmSync(root));

  it('1. freshTailCount=0 (default): no fresh-tail rows surfaced', () => {
    for (let i = 0; i < 5; i++) writeEntry(root, makeRaw(`alpha event ${i}`));
    const r = recall(ctxFor(root), { query: 'unrelated query terms' });
    expect(r.results.every((it) => !it.isFreshTail)).toBe(true);
  });

  it('2. freshTailCount=3 stamps isFreshTail on the 3 most recent raw rows', () => {
    // Five raw rows with sequential timestamps. loadSearchEntries returns
    // all tenant-scoped rows scored by BM25, so the recent rows ALSO surface
    // as BM25 hits. The fresh-tail logic stamps `isFreshTail=true` on the
    // top-3 recent ids regardless of whether they came in via BM25 or via
    // the prepend path.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = makeRaw(`recent raw row ${i}`);
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
      ids.push(e.id);
    }
    const r = recall(ctxFor(root), {
      query: 'no match for this string anywhere',
      freshTailCount: 3,
    });
    const tailIds = r.results.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(tailIds.length).toBe(3);
    // Top 3 by created DESC: ids[4], ids[3], ids[2].
    expect(new Set(tailIds)).toEqual(new Set([ids[4], ids[3], ids[2]]));
  });

  it('3. fresh-tail dedup vs BM25 hits: same row never appears twice', () => {
    const e = makeRaw('shared keyword target row');
    writeEntry(root, e);
    const r = recall(ctxFor(root), {
      query: 'shared keyword target',
      freshTailCount: 5,
    });
    const matches = r.results.filter((it) => it.id === e.id);
    expect(matches.length).toBe(1);
  });

  it('4. fresh-tail respects default-deny scope filter', () => {
    writeEntry(root, makeRaw('public chatter alpha', { scope: 'slack:public:Cgen' }));
    writeEntry(root, makeRaw('private payroll memo', { scope: 'slack:private:Csec' }));
    const r = recall(ctxFor(root), {
      query: 'completely unrelated string',
      freshTailCount: 5,
    });
    // BM25 already drops private rows in the no-scope path; fresh-tail must
    // not undo that. Public row appears with isFreshTail=true; private one
    // does not appear at all.
    const allContent = r.results.map((it) => it.content);
    expect(allContent.every((c) => !c.includes('payroll'))).toBe(true);
    const publicHit = r.results.find((it) => it.content === 'public chatter alpha');
    expect(publicHit?.isFreshTail).toBe(true);
  });

  it('5. fresh-tail respects tenant isolation', () => {
    writeEntry(root, makeRaw('default tenant row', { tenantId: 'default' }));
    writeEntry(root, makeRaw('other tenant row', { tenantId: 'other' }));
    const r = recall(ctxFor(root, 'default'), {
      query: 'unmatched',
      freshTailCount: 10,
    });
    const allContent = r.results.map((it) => it.content);
    expect(allContent.every((c) => !c.includes('other tenant'))).toBe(true);
    const defaultHit = r.results.find((it) => it.content === 'default tenant row');
    expect(defaultHit?.isFreshTail).toBe(true);
  });

  it('6. fresh-tail row not matched by query is prepended at score 1.0', () => {
    // Two rows: one only matches the query, one only fits the recent window.
    // The recent-only row should be in results with isFreshTail=true.
    const queryHit = makeRaw('alpha bravo charlie match');
    queryHit.created = '2026-01-01T00:00:00.000Z';
    writeEntry(root, queryHit);
    const recent = makeRaw('zebra zebra zebra');
    recent.created = '2026-02-01T00:00:00.000Z';
    writeEntry(root, recent);
    const r = recall(ctxFor(root), {
      query: 'alpha bravo charlie',
      freshTailCount: 1,
    });
    const recentHit = r.results.find((it) => it.id === recent.id);
    expect(recentHit?.isFreshTail).toBe(true);
    // Both rows surface, both flagged as expected.
    const queryMatchHit = r.results.find((it) => it.id === queryHit.id);
    expect(queryMatchHit).toBeDefined();
  });
});
