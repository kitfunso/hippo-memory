// detectChurnStale reads only the current rows of the projects it checks, and counts and skips the same rows as a whole-tenant read.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { MemoryEntry } from '../../src/core/memory.js';
import { detectChurnStale } from '../../src/learn/invalidation.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/rows.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { writeEntry, writeEntriesTogether, loadAllEntries } from '../_helpers/root-forms.js';

/** loadAllEntries' statement: every full row of one tenant. */
const TENANT_READ = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created ASC, id ASC`;
// Content with no path, symbol or script, so no candidate needs git and the repo is never read.
const NO_REFS_REPO = '/no/such/repo';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(): string {
  const root = makeRoot('churn-candidates');
  roots.push(root);
  return root;
}

function build(label: string, extra: Partial<MemoryEntry> = {}, tenantId = 'default'): MemoryEntry {
  return {
    ...createMemory(`${label}: a plain note about the team`, { tenantId }),
    originProject: 'proj',
    ...extra,
  };
}

function put(root: string, label: string, extra: Partial<MemoryEntry> = {}, tenantId = 'default'): string {
  const entry = build(label, extra, tenantId);
  writeEntry(root, entry);
  return entry.id;
}

function setColumn(root: string, column: 'superseded_by' | 'created', value: string, id: string): void {
  const db = openHippoDb(root);
  try {
    db.prepare(`UPDATE memories SET ${column} = ? WHERE id = ?`).run(value, id);
  } finally {
    closeHippoDb(db);
  }
}

describe('detectChurnStale candidate read', () => {
  it('checks and skips the same rows, in store order, with and without a legacy name', () => {
    const root = newRoot();
    const checked = new Set<string>();
    const legacyChecked = new Set<string>();
    const pinned = new Set<string>();
    checked.add(put(root, 'current'));
    checked.add(put(root, 'kind superseded', { kind: 'superseded' }));
    const emptySupersededBy = put(root, 'empty superseded_by');
    setColumn(root, 'superseded_by', '', emptySupersededBy);
    checked.add(emptySupersededBy);
    legacyChecked.add(put(root, 'legacy', { originProject: 'legacy' }));
    pinned.add(put(root, 'pinned', { pinned: true }));
    // Pinned is judged before the date, so a pinned row with no usable date is still reported.
    const pinnedBadDate = put(root, 'pinned bad date', { pinned: true });
    setColumn(root, 'created', 'not a date', pinnedBadDate);
    pinned.add(pinnedBadDate);
    setColumn(root, 'created', 'not a date', put(root, 'bad date'));
    setColumn(root, 'superseded_by', 'mem-next', put(root, 'superseded', { pinned: true }));
    put(root, 'raw', { kind: 'raw', pinned: true });
    put(root, 'archived', { kind: 'archived' });
    put(root, 'global', { originProject: '' });
    put(root, 'unassigned', { originProject: null });
    put(root, 'other project', { originProject: 'other' });
    put(root, 'case differs', { originProject: 'Proj' });
    put(root, 'other tenant', { pinned: true }, 'other');

    const order = loadAllEntries(root, 'default').map((e) => e.id);
    const inOrder = (ids: Set<string>): string[] => order.filter((id) => ids.has(id));
    for (const legacyName of [undefined, 'legacy', '']) {
      const result = detectChurnStale(sqliteSyncStore(root).localFiles.learning, NO_REFS_REPO, {
        tenantId: 'default',
        projectName: 'proj',
        legacyName,
        dryRun: true,
      });
      expect(result.checked, `legacy ${legacyName}`).toBe(
        checked.size + (legacyName === 'legacy' ? legacyChecked.size : 0),
      );
      expect(result.skippedPinned).toEqual(inOrder(pinned));
      expect(result.marked).toBe(0);
    }
  });

  it('reads no row of another project', () => {
    const root = newRoot();
    writeEntriesTogether(
      root,
      Array.from({ length: 30 }, (_, i) => build(`other ${i}`, { originProject: 'other' })),
    );
    const pinned = put(root, 'pinned', { pinned: true });
    put(root, 'current');
    const { result, statements, rowsRead } = recordStatements(() =>
      detectChurnStale(sqliteSyncStore(root).localFiles.learning, NO_REFS_REPO, {
        tenantId: 'default',
        projectName: 'proj',
      }),
    );
    expect(result.checked).toBe(1);
    expect(result.skippedPinned).toEqual([pinned]);
    expect(countMatching(statements, TENANT_READ)).toBe(0);
    expect(rowsRead).toBeLessThan(30);
  });
});
