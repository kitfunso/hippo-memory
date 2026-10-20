/**
 * v1.5.0 DAG-aware recall — Task 2.
 *
 * When a query overflows the result `limit` and ≥2 of the dropped leaves
 * share a level-2 parent summary, recall appends that summary so the user
 * gets a compact pointer to the missing detail. Capped at ceil(limit * 0.3)
 * substitutions, scope/tenant filtered, and reversible via Task 3 drillDown.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { writeEntry, writeEntriesTogether } from '../_helpers/root-forms.js';

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

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
  afterEach(() => safeRmSync(root));

  it('1. no DAG, no substitution', async () => {
    // 30 leaves, no parent summary. limit=10 should return 10 with no isSummary marker.
    writeEntriesTogether(
      root,
      Array.from({ length: 30 }, (_, i) => makeLeaf(`alpha bravo charlie ${i}`)),
    );
    const r = await retrieve(ctxFor(root), { query: 'alpha bravo charlie', window: { limit: 10 } });
    expect(r.results.length).toBe(10);
    expect(r.results.every((it) => !it.isSummary)).toBe(true);
  });

  it('2. limit tight, summary substitutes for overflow', async () => {
    // 1 summary + 12 children. limit=5 means 7 children overflow; summary
    // should be appended.
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
    // No scope passed; default-deny should drop the leaves AND prevent
    // the summary from being substituted in.
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
    // Recall as default tenant: nothing should match (entries belong to other),
    // and even if loadEntriesByIds saw the parent ID, tenant filter blocks it.
    const r = await retrieve(ctxFor(root, 'default'), { query: 'alpha cross tenant', window: { limit: 3 } });
    expect(r.results).toHaveLength(0);
  });

  it('5. substitution count capped at ceil(limit * 0.3)', async () => {
    // 5 separate summaries, each with 3 overflowing children. limit=10.
    // ceil(10 * 0.3) = 3. Only 3 summaries should be substituted.
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
    // Pad with 10 unrelated leaves so limit=10 gets fully consumed and
    // every summary's children overflow.
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
    // Parent summary itself matches the query strongly and ranks in the top
    // limit. Substitution must NOT add it again.
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
