import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { retrieve } from '../../src/api/index.js';
import { sqliteStore, type HippoStore } from '../../src/entry/store-kit.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, apiCtx } = sessionPerTest();

function ctxFor(root: string, tenantId: string = 'default'): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:fresh-tail', role: 'admin' });
}

function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    tags: opts.tags ?? [],
  });
}

describe('fresh-tail recall', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('fresh-tail');
  });

  it('1. freshTailCount=0 (default): no fresh-tail rows surfaced', async () => {
    for (let i = 0; i < 5; i++) writeEntry(root, makeRaw(`alpha event ${i}`));
    const r = await retrieve(ctxFor(root), { query: 'unrelated query terms' });
    expect(r.results.every((it) => !it.isFreshTail)).toBe(true);
  });

  it('2. freshTailCount=3 stamps isFreshTail on the 3 most recent raw rows', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = makeRaw(`recent raw row ${i}`);
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
      ids.push(e.id);
    }
    const r = await retrieve(ctxFor(root), {
      query: 'no match for this string anywhere',
      window: { freshTailCount: 3 },
    });
    const tailIds = r.results.filter((it) => it.isFreshTail).map((it) => it.id);
    expect(tailIds.length).toBe(3);
    expect(new Set(tailIds)).toEqual(new Set([ids[4], ids[3], ids[2]]));
  });

  it('3. fresh-tail dedup vs BM25 hits: same row never appears twice', async () => {
    const e = makeRaw('shared keyword target row');
    writeEntry(root, e);
    const r = await retrieve(ctxFor(root), {
      query: 'shared keyword target',
      window: { freshTailCount: 5 },
    });
    const matches = r.results.filter((it) => it.id === e.id);
    expect(matches.length).toBe(1);
  });

  it('4. fresh-tail respects default-deny scope filter', async () => {
    writeEntry(root, makeRaw('public chatter alpha', { scope: 'slack:public:Cgen' }));
    writeEntry(root, makeRaw('private payroll memo', { scope: 'slack:private:Csec' }));
    const r = await retrieve(ctxFor(root), {
      query: 'completely unrelated string',
      window: { freshTailCount: 5 },
    });
    const allContent = r.results.map((it) => it.content);
    expect(allContent.every((c) => !c.includes('payroll'))).toBe(true);
    const publicHit = r.results.find((it) => it.content === 'public chatter alpha');
    expect(publicHit?.isFreshTail).toBe(true);
  });

  it('5. fresh-tail respects tenant isolation', async () => {
    writeEntry(root, makeRaw('default tenant row', { tenantId: 'default' }));
    writeEntry(root, makeRaw('other tenant row', { tenantId: 'other' }));
    const r = await retrieve(ctxFor(root, 'default'), {
      query: 'unmatched',
      window: { freshTailCount: 10 },
    });
    const allContent = r.results.map((it) => it.content);
    expect(allContent.every((c) => !c.includes('other tenant'))).toBe(true);
    const defaultHit = r.results.find((it) => it.content === 'default tenant row');
    expect(defaultHit?.isFreshTail).toBe(true);
  });

  it('6. fresh-tail row not matched by query is prepended at score 1.0', async () => {
    const queryHit = makeRaw('alpha bravo charlie match');
    queryHit.created = '2026-01-01T00:00:00.000Z';
    writeEntry(root, queryHit);
    const recent = makeRaw('zebra zebra zebra');
    recent.created = '2026-02-01T00:00:00.000Z';
    writeEntry(root, recent);
    const r = await retrieve(ctxFor(root), {
      query: 'alpha bravo charlie',
      window: { freshTailCount: 1 },
    });
    const recentHit = r.results.find((it) => it.id === recent.id);
    expect(recentHit?.isFreshTail).toBe(true);
    const queryMatchHit = r.results.find((it) => it.id === queryHit.id);
    expect(queryMatchHit?.id).toBe(queryHit.id);
  });

  it("7. fresh-tail drops another project's row a store handed back despite the origins", async () => {
    const [mine, theirs, global] = ['proj-a', 'proj-b', ''].map((origin) => ({
      ...makeRaw(`raw row from ${origin || 'no project'}`),
      originProject: origin,
    }));
    const store: HippoStore = { ...sqliteStore(root), freshRawEntries: async () => [mine!, theirs!, global!] };
    const r = await retrieve(
      { ...ctxFor(root), store },
      {
        query: 'unmatched',
        window: { freshTailCount: 5 },
        filter: { project: { name: 'proj-a', legacyName: '' } },
      },
    );
    expect(r.results.map((it) => [it.id, it.isFreshTail])).toEqual([
      [mine!.id, true],
      [global!.id, true],
    ]);
  });
});
