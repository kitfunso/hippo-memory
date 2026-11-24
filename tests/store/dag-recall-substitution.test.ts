import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, apiCtx } = sessionPerTest();

function ctxFor(root: string, tenantId: string = 'default'): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:recall-sub', role: 'admin' });
}

function makeLeaf(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    tags: opts.tags ?? [],
    confidence: 'observed',
    dagLevel: opts.dagLevel ?? 0,
    dagParentId: opts.dagParentId ?? undefined,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    kind: opts.kind ?? 'distilled',
  });
  return e;
}

function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const s = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Semantic,
    tags: opts.tags ?? ['dag-summary'],
    confidence: 'inferred',
    dagLevel: 2,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
  return s;
}

describe('DAG-aware recall substitution', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('dag-sub');
  });

  it('1. no DAG, no substitution', async () => {
    writeEntriesTogether(
      root,
      Array.from({ length: 30 }, (_, i) => makeLeaf(`alpha bravo charlie ${i}`)),
    );
    const r = await retrieve(ctxFor(root), { query: 'alpha bravo charlie', window: { limit: 10 } });
    expect(r.results.length).toBe(10);
    expect(r.results.every((it) => !it.isSummary)).toBe(true);
  });

  it('2. limit tight, summary substitutes for overflow', async () => {
    const summary = makeSummary('topic alpha rollup', { tags: ['dag-summary', 'topic:alpha'] });
    summary.descendantCount = 12;
    writeEntry(root, summary);
    for (let i = 0; i < 12; i++) {
      writeEntry(
        root,
        makeLeaf(`alpha detail event ${i}`, {
          dagLevel: 1,
          dagParentId: summary.id,
        }),
      );
    }

    const r = await retrieve(ctxFor(root), { query: 'alpha detail event', window: { limit: 5 } });
    const summaries = r.results.filter((it) => it.isSummary);
    expect(summaries.length).toBe(1);
    expect(summaries[0].id).toBe(summary.id);
    expect(summaries[0].substitutedFor?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(summaries[0].descendantCount).toBe(12);
  });

  it('3. private summary not surfaced when query has no scope', async () => {
    const summary = makeSummary('private topic', { scope: 'slack:private:CSEC' });
    writeEntry(root, summary);
    for (let i = 0; i < 8; i++) {
      writeEntry(
        root,
        makeLeaf(`secret payroll detail ${i}`, {
          dagLevel: 1,
          dagParentId: summary.id,
          scope: 'slack:private:CSEC',
        }),
      );
    }
    const r = await retrieve(ctxFor(root), { query: 'secret payroll detail', window: { limit: 3 } });
    expect(r.results.every((it) => !it.isSummary)).toBe(true);
  });

  it('4. cross-tenant summary not loaded', async () => {
    const summary = makeSummary('other tenant topic', { tenantId: 'other' });
    writeEntry(root, summary);
    for (let i = 0; i < 6; i++) {
      writeEntry(
        root,
        makeLeaf(`alpha cross tenant ${i}`, {
          dagLevel: 1,
          dagParentId: summary.id,
          tenantId: 'other',
        }),
      );
    }
    const r = await retrieve(ctxFor(root, 'default'), { query: 'alpha cross tenant', window: { limit: 3 } });
    expect(r.results).toHaveLength(0);
  });

  it('5. substitution count capped at ceil(limit * 0.3)', async () => {
    for (let s = 0; s < 5; s++) {
      const summary = makeSummary(`topic ${s} summary`, { tags: ['dag-summary', `topic:${s}`] });
      writeEntry(root, summary);
      for (let c = 0; c < 3; c++) {
        writeEntry(
          root,
          makeLeaf(`alpha topic event ${s}-${c}`, {
            dagLevel: 1,
            dagParentId: summary.id,
          }),
        );
      }
    }
    for (let i = 0; i < 10; i++) {
      writeEntry(root, makeLeaf(`alpha unrelated padding ${i}`));
    }
    const r = await retrieve(ctxFor(root), { query: 'alpha topic event', window: { limit: 10 } });
    const summaries = r.results.filter((it) => it.isSummary);
    expect(summaries.length).toBeLessThanOrEqual(3);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  });

  it('6. summarizeOverflow:false disables substitution', async () => {
    const summary = makeSummary('topic gamma', { tags: ['dag-summary'] });
    summary.descendantCount = 6;
    writeEntry(root, summary);
    for (let i = 0; i < 6; i++) {
      writeEntry(
        root,
        makeLeaf(`gamma detail ${i}`, {
          dagLevel: 1,
          dagParentId: summary.id,
        }),
      );
    }
    const r = await retrieve(ctxFor(root), { query: 'gamma detail', window: { limit: 3, summarizeOverflow: false } });
    expect(r.results.length).toBe(3);
    expect(r.results.every((it) => !it.isSummary)).toBe(true);
  });

  it('7. parent already in baseSlice is not duplicated as a substitution', async () => {
    const summary = makeSummary('shared keyword summary marker', { tags: ['dag-summary', 'topic:shared'] });
    summary.descendantCount = 4;
    writeEntry(root, summary);
    for (let i = 0; i < 4; i++) {
      writeEntry(
        root,
        makeLeaf(`shared keyword summary marker leaf ${i}`, {
          dagLevel: 1,
          dagParentId: summary.id,
        }),
      );
    }
    const r = await retrieve(ctxFor(root), { query: 'shared keyword summary marker', window: { limit: 2 } });
    const summaryHits = r.results.filter((it) => it.id === summary.id);
    expect(summaryHits.length).toBe(1);
  });
});
