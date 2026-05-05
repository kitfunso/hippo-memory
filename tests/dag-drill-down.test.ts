/**
 * v1.5.0 DAG-aware recall — Task 3 drillDown.
 *
 * Companion to api.recall's substitution path. When recall surfaces a level-2
 * summary in place of overflowed children, drillDown walks one step down the
 * DAG to recover the originals. Tenant scope and the *:private:* default-deny
 * are enforced on both the summary and its children.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { drillDown, type Context } from '../src/api.js';

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
  return { hippoRoot: root, tenantId, actor: 'test:drill' };
}

function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Semantic,
    tags: opts.tags ?? ['dag-summary'],
    confidence: 'inferred',
    dag_level: 2,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
}

function makeChild(text: string, parentId: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Episodic,
    confidence: 'observed',
    dag_level: opts.dag_level ?? 1,
    dag_parent_id: parentId,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
}

describe('drillDown', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('drill'); });
  afterEach(() => safeRmSync(root));

  it('returns the summary plus its direct children', () => {
    const s = makeSummary('topic alpha');
    s.descendant_count = 4;
    s.earliest_at = '2026-01-01T00:00:00.000Z';
    s.latest_at = '2026-01-04T00:00:00.000Z';
    writeEntry(root, s);
    const childIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = makeChild(`alpha detail ${i}`, s.id);
      writeEntry(root, c);
      childIds.push(c.id);
    }
    const r = drillDown(ctxFor(root), s.id);
    expect(r).not.toBeNull();
    expect(r!.summary.id).toBe(s.id);
    expect(r!.summary.descendantCount).toBe(4);
    expect(r!.summary.earliestAt).toBe('2026-01-01T00:00:00.000Z');
    expect(r!.children.length).toBe(4);
    expect(r!.children.map((c) => c.id).sort()).toEqual(childIds.sort());
    expect(r!.totalChildren).toBe(4);
    expect(r!.truncated).toBe(false);
  });

  it('returns null on a leaf (level 0/1 are not drillable)', () => {
    const leaf = createMemory('leaf body', {
      layer: Layer.Buffer,
      dag_level: 0,
      tenantId: 'default',
    });
    writeEntry(root, leaf);
    const r = drillDown(ctxFor(root), leaf.id);
    expect(r).toBeNull();
  });

  it('returns null when summary belongs to another tenant', () => {
    const s = makeSummary('other tenant topic', { tenantId: 'other' });
    writeEntry(root, s);
    writeEntry(root, makeChild('detail', s.id, { tenantId: 'other' }));
    const r = drillDown(ctxFor(root, 'default'), s.id);
    expect(r).toBeNull();
  });

  it('returns null when summary scope is private and caller has no scope', () => {
    const s = makeSummary('private topic', { scope: 'slack:private:CSEC' });
    writeEntry(root, s);
    writeEntry(root, makeChild('secret detail', s.id, { scope: 'slack:private:CSEC' }));
    const r = drillDown(ctxFor(root), s.id);
    expect(r).toBeNull();
  });

  it('filters out children whose scope fails the default-deny check', () => {
    // Public summary, but one child accidentally tagged private. Should NOT
    // appear in the children list (defense in depth — even if the DAG is
    // misbuilt, drill cannot leak).
    const s = makeSummary('public topic', { scope: 'slack:public:CGEN' });
    writeEntry(root, s);
    writeEntry(root, makeChild('public child', s.id, { scope: 'slack:public:CGEN' }));
    writeEntry(root, makeChild('rogue private', s.id, { scope: 'slack:private:CSEC' }));
    const r = drillDown(ctxFor(root, 'default'), s.id);
    expect(r).not.toBeNull();
    expect(r!.children.length).toBe(1);
    expect(r!.children[0].content).toBe('public child');
    expect(r!.totalChildren).toBe(1);
  });

  it('budget option truncates children list and sets truncated=true', () => {
    const s = makeSummary('topic budget');
    writeEntry(root, s);
    for (let i = 0; i < 10; i++) {
      writeEntry(root, makeChild(`detail ${i} `.repeat(20), s.id));
    }
    const r = drillDown(ctxFor(root), s.id, { budget: 100 });
    expect(r).not.toBeNull();
    expect(r!.truncated).toBe(true);
    expect(r!.children.length).toBeLessThan(10);
  });

  it('limit option caps children list', () => {
    const s = makeSummary('topic limit');
    writeEntry(root, s);
    for (let i = 0; i < 30; i++) {
      writeEntry(root, makeChild(`detail row ${i}`, s.id));
    }
    const r = drillDown(ctxFor(root), s.id, { limit: 5 });
    expect(r).not.toBeNull();
    expect(r!.children.length).toBe(5);
    expect(r!.truncated).toBe(true);
    expect(r!.totalChildren).toBe(30);
  });
});
