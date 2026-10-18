// Quality repair over a tenant larger than one page: the same plan and the same moves as one whole read gave.
import { beforeEach, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { PROTECTED_ROWS } from '../../src/core/memory-audit.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { insertDormantRow, readDormantSnapshot } from '../../src/store/sqlite/dormant-rows.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { mergedText } from '../../src/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { repairAutomaticMemories } from '../_helpers/root-forms.js';

const ROWS = 1100;
const HEADER = '[Consolidated from 2 related memories, newest first]';
const PART_A = 'bump build 78 for testflight deploy';
const PART_B = 'bump build 79 for testflight deploy';

let root: string;
beforeEach(() => {
  root = makeRoot('quality-repair-pages');
});

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

const automatic = (content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { source: 'capture', confidence: 'observed', layer: Layer.Episodic }),
  ...extra,
});

/** The parent that sits in dormant storage, and every live row by its place in store order. */
function seed() {
  const dormantParent = automatic(PART_B);
  const special = new Map<number, (ids: string[]) => MemoryEntry>([
    [10, () => automatic('Found local migration files to be')],
    [30, (ids) => automatic(mergedText(HEADER, [PART_A, PART_B]), bundleOf([ids[10], ids[20]]))],
    [20, () => automatic(PART_B, { source: 'cli', confidence: 'verified' })],
    [520, () => automatic(PART_A)],
    [600, () => automatic('Always check which branch the PR merges into')],
    [700, () => automatic(PART_A, { pinned: true })],
    [800, (ids) => automatic('Found local migration files to be', { supersededBy: ids[0] })],
    [801, () => automatic('Found local migration files to be', { kind: 'archived' })],
    [900, () => automatic('Found local migration files to be', { tenantId: 'other' })],
    [1090, (ids) => automatic(mergedText(HEADER, [PART_A, PART_B]), bundleOf([ids[520], dormantParent.id]))],
  ]);
  const ids: string[] = [];
  withDb((db) => {
    db.exec('BEGIN');
    try {
      insertDormantRow(db, { entry: dormantParent, strength: 0.1, reason: 'decay', dormantAt: '2026-03-01T00:00:00Z' });
      for (let i = 0; i < ROWS; i++) {
        const make = special.get(i);
        const entry = make
          ? make(ids)
          : automatic(`Run migrations before seeding because seed row ${i} needs table ${i % 9} present.`);
        writeEntryDbOnly(db, { ...entry, created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
        ids.push(entry.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  return { ids, dormantParent: dormantParent.id };
}

function bundleOf(parents: string[]): Partial<MemoryEntry> {
  return { source: 'consolidation', layer: Layer.Semantic, parents };
}

const run = (apply = false) =>
  repairAutomaticMemories({ hippoRoot: root }, { tenantId: 'default', apply, protect: PROTECTED_ROWS });

describe('quality repair across pages', () => {
  it('plans every issue in store order, judging a bundle by parents on other pages and in dormant storage', () => {
    const { ids } = seed();

    const plan = run();

    expect(plan.total).toBe(ROWS - 3);
    expect(plan.issues.map((issue) => [issue.id, issue.disposition, issue.protection])).toEqual([
      [ids[10], 'set-aside', undefined],
      [ids[30], 'review', undefined],
      [ids[520], 'set-aside', undefined],
      [ids[600], 'review', undefined],
      [ids[700], 'protected', 'pinned'],
      [ids[1090], 'set-aside', undefined],
    ]);
    expect(plan.issues[0].reason).toBe('sentence-fragment');
  });

  it('moves exactly the planned set-aside rows to dormant storage', () => {
    const { ids } = seed();

    const applied = run(true);

    expect(applied.appliedIds).toEqual([ids[10], ids[520], ids[1090]]);
    expect(applied.warnings).toEqual([]);
    withDb((db) => {
      for (const id of applied.appliedIds) expect(readDormantSnapshot(db, 'default', id)?.entry.id).toBe(id);
    });
    expect(run().issues.map((issue) => issue.id)).toEqual([ids[30], ids[600], ids[700]]);
  });
});
