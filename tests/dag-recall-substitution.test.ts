/**
 * v1.5.0 DAG-aware recall — Task 2.
 *
 * When a query overflows the result `limit` and ≥2 of the dropped leaves
 * share a level-2 parent summary, recall appends that summary so the user
 * gets a compact pointer to the missing detail. Capped at ceil(limit * 0.3)
 * substitutions, scope/tenant filtered, and reversible via Task 3 drillDown.
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

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: 'test:recall-sub' };
}

function makeLeaf(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory(text, {
    layer: Layer.Buffer,
    tags: opts.tags ?? [],
    confidence: 'observed',
    dag_level: opts.dag_level ?? 0,
    dag_parent_id: opts.dag_parent_id,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    kind: (opts.kind ?? 'distilled') as MemoryKind,
  });
  return e;
}

function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const s = createMemory(text, {
    layer: Layer.Semantic,
    tags: opts.tags ?? ['dag-summary'],
    confidence: 'inferred',
    dag_level: 2,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
  return s;
}

describe('DAG-aware recall substitution', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('dag-sub'); });
  afterEach(() => safeRmSync(root));

  it('1. no DAG, no substitution', () => {
    // 30 leaves, no parent summary. limit=10 should return 10 with no isSummary marker.
    for (let i = 0; i < 30; i++) {
      writeEntry(root, makeLeaf(`alpha bravo charlie ${i}`));
    }
    const r = recall(ctxFor(root), { query: 'alpha bravo charlie', limit: 10 });
    expect(r.results.length).toBe(10);
    expect(r.results.every((it) => !it.isSummary)).toBe(true);
  });

  it('2. limit tight, summary substitutes for overflow', () => {
    // 1 summary + 12 children. limit=5 means 7 children overflow; summary
    // should be appended.
    const summary = makeSummary('topic alpha rollup', { tags: ['dag-summary', 'topic:alpha'] });
    summary.descendant_count = 12;
    writeEntry(root, summary);
    for (let i = 0; i < 12; i++) {
      writeEntry(root, makeLeaf(`alpha detail event ${i}`, {
        dag_level: 1,
        dag_parent_id: summary.id,
      }));
    }

    const r = recall(ctxFor(root), { query: 'alpha detail event', limit: 5 });
    const summaries = r.results.filter((it) => it.isSummary);
    expect(summaries.length).toBe(1);
    expect(summaries[0].id).toBe(summary.id);
    expect(summaries[0].substitutedFor?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(summaries[0].descendantCount).toBe(12);
  });

  it('3. private summary not surfaced when query has no scope', () => {
    const summary = makeSummary('private topic', { scope: 'slack:private:CSEC' });
    writeEntry(root, summary);
    for (let i = 0; i < 8; i++) {
      writeEntry(root, makeLeaf(`secret payroll detail ${i}`, {
        dag_level: 1,
        dag_parent_id: summary.id,
        scope: 'slack:private:CSEC',
      }));
    }
    // No scope passed; default-deny should drop the leaves AND prevent
    // the summary from being substituted in.
    const r = recall(ctxFor(root), { query: 'secret payroll detail', limit: 3 });
    expect(r.results.every((it) => !it.isSummary)).toBe(true);
  });

  it('4. cross-tenant summary not loaded', () => {
    const summary = makeSummary('other tenant topic', { tenantId: 'other' });
    writeEntry(root, summary);
    for (let i = 0; i < 6; i++) {
      writeEntry(root, makeLeaf(`alpha cross tenant ${i}`, {
        dag_level: 1,
        dag_parent_id: summary.id,
        tenantId: 'other',
      }));
    }
    // Recall as default tenant: nothing should match (entries belong to other),
    // and even if loadEntriesByIds saw the parent ID, tenant filter blocks it.
    const r = recall(ctxFor(root, 'default'), { query: 'alpha cross tenant', limit: 3 });
    expect(r.results).toHaveLength(0);
  });

  it('5. substitution count capped at ceil(limit * 0.3)', () => {
    // 5 separate summaries, each with 3 overflowing children. limit=10.
    // ceil(10 * 0.3) = 3. Only 3 summaries should be substituted.
    for (let s = 0; s < 5; s++) {
      const summary = makeSummary(`topic ${s} summary`, { tags: ['dag-summary', `topic:${s}`] });
      writeEntry(root, summary);
      for (let c = 0; c < 3; c++) {
        writeEntry(root, makeLeaf(`alpha topic event ${s}-${c}`, {
          dag_level: 1,
          dag_parent_id: summary.id,
        }));
      }
    }
    // Pad with 10 unrelated leaves so limit=10 gets fully consumed and
    // every summary's children overflow.
    for (let i = 0; i < 10; i++) {
      writeEntry(root, makeLeaf(`alpha unrelated padding ${i}`));
    }
    const r = recall(ctxFor(root), { query: 'alpha topic event', limit: 10 });
    const summaries = r.results.filter((it) => it.isSummary);
    expect(summaries.length).toBeLessThanOrEqual(3);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  });

  it('6. summarizeOverflow:false disables substitution', () => {
    const summary = makeSummary('topic gamma', { tags: ['dag-summary'] });
    summary.descendant_count = 6;
    writeEntry(root, summary);
    for (let i = 0; i < 6; i++) {
      writeEntry(root, makeLeaf(`gamma detail ${i}`, {
        dag_level: 1,
        dag_parent_id: summary.id,
      }));
    }
    const r = recall(ctxFor(root), { query: 'gamma detail', limit: 3, summarizeOverflow: false });
    expect(r.results.length).toBe(3);
    expect(r.results.every((it) => !it.isSummary)).toBe(true);
  });

  it('7. parent already in baseSlice is not duplicated as a substitution', () => {
    // Parent summary itself matches the query strongly and ranks in the top
    // limit. Substitution must NOT add it again.
    const summary = makeSummary('shared keyword summary marker', { tags: ['dag-summary', 'topic:shared'] });
    summary.descendant_count = 4;
    writeEntry(root, summary);
    for (let i = 0; i < 4; i++) {
      writeEntry(root, makeLeaf(`shared keyword summary marker leaf ${i}`, {
        dag_level: 1,
        dag_parent_id: summary.id,
      }));
    }
    const r = recall(ctxFor(root), { query: 'shared keyword summary marker', limit: 2 });
    const summaryHits = r.results.filter((it) => it.id === summary.id);
    expect(summaryHits.length).toBe(1);
  });
});
