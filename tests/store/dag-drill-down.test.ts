/**
 * v1.5.0 DAG-aware recall — Task 3 drillDown.
 *
 * Companion to api.recall's substitution path. When recall surfaces a level-2
 * summary in place of overflowed children, drillDown walks one step down the
 * DAG to recover the originals. Tenant scope and the *:private:* default-deny
 * are enforced on both the summary and its children.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { drillDown } from '../../src/api/index.js';
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
  return apiCtx(root, tenantId, { subject: 'test:drill', role: 'admin' });
}

function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Semantic,
    tags: opts.tags ?? ['dag-summary'],
    confidence: 'inferred',
    dagLevel: 2,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
}

function makeChild(text: string, parentId: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Episodic,
    confidence: 'observed',
    dagLevel: opts.dagLevel ?? 1,
    dagParentId: parentId,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
}

describe('drillDown', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('drill');
  });
  afterEach(() => safeRmSync(root));

  it('returns the summary plus its direct children', async () => {
    const s = makeSummary('topic alpha');
    s.descendantCount = 4;
    s.earliestAt = '2026-01-01T00:00:00.000Z';
    s.latestAt = '2026-01-04T00:00:00.000Z';
    writeEntry(root, s);
    const childIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = makeChild(`alpha detail ${i}`, s.id);
      writeEntry(root, c);
      childIds.push(c.id);
    }
    const r = await drillDown(ctxFor(root), s.id);
    expect('failure' in r).toBe(false);
    if ('failure' in r) return;
    expect(r.summary.id).toBe(s.id);
    expect(r.summary.descendantCount).toBe(4);
    expect(r.summary.earliestAt).toBe('2026-01-01T00:00:00.000Z');
    expect(r.children.length).toBe(4);
    expect(r.children.map((c) => c.id).sort()).toEqual(childIds.sort());
    expect(r.totalChildren).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it('filters out children whose scope fails the default-deny check', async () => {
    // Public summary, but one child accidentally tagged private. Should NOT
    // appear in the children list (defense in depth — even if the DAG is
    // misbuilt, drill cannot leak).
    const s = makeSummary('public topic', { scope: 'slack:public:CGEN' });
    writeEntry(root, s);
    writeEntry(root, makeChild('public child', s.id, { scope: 'slack:public:CGEN' }));
    writeEntry(root, makeChild('rogue private', s.id, { scope: 'slack:private:CSEC' }));
    const r = await drillDown(ctxFor(root, 'default'), s.id);
    expect('failure' in r).toBe(false);
    if ('failure' in r) return;
    expect(r.children.length).toBe(1);
    expect(r.children[0].content).toBe('public child');
    expect(r.totalChildren).toBe(1);
  });

  it('budget option truncates children list and sets truncated=true', async () => {
    const s = makeSummary('topic budget');
    writeEntry(root, s);
    for (let i = 0; i < 10; i++) {
      writeEntry(root, makeChild(`detail ${i} `.repeat(20), s.id));
    }
    const r = await drillDown(ctxFor(root), s.id, { budget: 100 });
    expect('failure' in r).toBe(false);
    if ('failure' in r) return;
    expect(r.truncated).toBe(true);
    expect(r.children.length).toBeLessThan(10);
  });

  it('limit option caps children list', async () => {
    const s = makeSummary('topic limit');
    writeEntry(root, s);
    writeEntriesTogether(
      root,
      Array.from({ length: 30 }, (_, i) => makeChild(`detail row ${i}`, s.id)),
    );
    const r = await drillDown(ctxFor(root), s.id, { limit: 5 });
    expect('failure' in r).toBe(false);
    if ('failure' in r) return;
    expect(r.children.length).toBe(5);
    expect(r.truncated).toBe(true);
    expect(r.totalChildren).toBe(30);
  });
});
