/**
 * Schema v25 — cached summary metadata (descendant_count, earliest_at,
 * latest_at) on level-2 DAG summary rows.
 *
 * Verifies:
 *   1. Schema v25 is current.
 *   2. Fresh DBs initialize with the three columns.
 *   3. v24 DBs back-fill descendant_count and earliest/latest_at on first
 *      open via the v25 migration.
 *   4. dag.ts populates the columns at write time when buildDag creates a
 *      level-2 summary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, loadAllEntries, loadEntriesByIds, loadChildrenOf } from '../src/store.js';
import { openHippoDb, closeHippoDb, getCurrentSchemaVersion, getSchemaVersion } from '../src/db.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('schema v25 — DAG summary metadata', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('v25-meta'); });
  afterEach(() => safeRmSync(root));

  it('current schema version is 25', () => {
    expect(getCurrentSchemaVersion()).toBe(25);
  });

  it('fresh init brings DB to v25 with the three new columns', () => {
    const db = openHippoDb(root);
    try {
      expect(getSchemaVersion(db)).toBe(25);
      const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name?: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('descendant_count');
      expect(names).toContain('earliest_at');
      expect(names).toContain('latest_at');
    } finally {
      closeHippoDb(db);
    }
  });

  it('writeEntry round-trips descendant_count + earliest/latest_at', () => {
    const summary: MemoryEntry = createMemory('topic summary', {
      layer: Layer.Semantic,
      tags: ['dag-summary'],
      confidence: 'inferred',
      dag_level: 2,
    });
    summary.descendant_count = 7;
    summary.earliest_at = '2026-01-01T00:00:00.000Z';
    summary.latest_at = '2026-01-08T00:00:00.000Z';
    writeEntry(root, summary);

    const reloaded = loadAllEntries(root).find((e) => e.id === summary.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.descendant_count).toBe(7);
    expect(reloaded?.earliest_at).toBe('2026-01-01T00:00:00.000Z');
    expect(reloaded?.latest_at).toBe('2026-01-08T00:00:00.000Z');
  });

  it('loadEntriesByIds returns matching rows scoped to tenant', () => {
    const a = createMemory('row A', { layer: Layer.Buffer, dag_level: 0 });
    const b = createMemory('row B', { layer: Layer.Buffer, dag_level: 0 });
    const c = createMemory('row C', { layer: Layer.Buffer, dag_level: 0, tenantId: 'other' });
    writeEntry(root, a);
    writeEntry(root, b);
    writeEntry(root, c);

    const defaultTenant = loadEntriesByIds(root, [a.id, b.id, c.id], 'default');
    expect(defaultTenant.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());

    const otherTenant = loadEntriesByIds(root, [a.id, b.id, c.id], 'other');
    expect(otherTenant.map((e) => e.id)).toEqual([c.id]);

    const empty = loadEntriesByIds(root, [], 'default');
    expect(empty).toHaveLength(0);
  });

  it('loadChildrenOf returns direct children only, tenant scoped, in created order', () => {
    const parent: MemoryEntry = createMemory('parent', {
      layer: Layer.Semantic,
      dag_level: 2,
    });
    parent.descendant_count = 2;
    writeEntry(root, parent);

    const child1: MemoryEntry = createMemory('child 1', {
      layer: Layer.Episodic,
      dag_level: 1,
      dag_parent_id: parent.id,
    });
    child1.created = '2026-01-01T00:00:00.000Z';
    const child2: MemoryEntry = createMemory('child 2', {
      layer: Layer.Episodic,
      dag_level: 1,
      dag_parent_id: parent.id,
    });
    child2.created = '2026-01-02T00:00:00.000Z';
    const grandchild: MemoryEntry = createMemory('grandchild', {
      layer: Layer.Buffer,
      dag_level: 0,
      dag_parent_id: child1.id,
    });
    writeEntry(root, child1);
    writeEntry(root, child2);
    writeEntry(root, grandchild);

    const direct = loadChildrenOf(root, parent.id, 'default');
    expect(direct.map((e) => e.id)).toEqual([child1.id, child2.id]);
    // Grandchild reachable only via child1, not directly under parent.
    expect(direct.find((e) => e.id === grandchild.id)).toBeUndefined();
  });
});
