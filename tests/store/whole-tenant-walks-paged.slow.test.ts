// Whole-tenant walks read keyset pages: no statement hands back more than a page of rows, and no row is dropped.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { peakRowsRead, recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  listMemoryConflicts,
  loadAllEntries,
  loadAllL2Summaries,
  loadAmbientCandidates,
  readEntry,
  replaceDetectedConflicts,
  writeEntriesTogether,
} from '../_helpers/root-forms.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { insertDormantRow, readDormantSnapshot } from '../../src/store/sqlite/dormant-rows.js';
import { fillRejectionDigests } from '../../src/store/sqlite/text-digests.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { DAG_LEVEL, type MemoryEntry } from '../../src/base/memory/entry.js';
import { READ_PAGE_ROWS } from '../../src/base/util/pages.js';

const ROWS = READ_PAGE_ROWS * 2 + 30;
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function seeded(pinned: boolean, extra: Partial<MemoryEntry> = {}) {
  const root = makeRoot('tenant-walk');
  roots.push(root);
  const entries = Array.from({ length: ROWS }, (_, i) => ({
    ...createMemory(`walk row ${i}`),
    id: `mem_w${String(i).padStart(5, '0')}`,
    pinned,
    ...extra,
    created: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(),
  }));
  writeEntriesTogether(root, entries);
  return { root, ids: entries.map((e) => e.id) };
}

describe('whole-tenant walks', () => {
  it('reads every pin in pages', () => {
    const { root, ids } = seeded(true);
    const { result, reads } = recordStatements(() => loadAmbientCandidates(root, 'default', 0, () => true));
    expect(result.entries.map((e) => e.id)).toEqual(ids);
    expect(peakRowsRead(reads, 'FROM memories')).toBeLessThanOrEqual(READ_PAGE_ROWS + 1);
  });

  it('reads a whole tenant in pages', () => {
    const { root, ids } = seeded(false);
    const { result, reads } = recordStatements(() => loadAllEntries(root, 'default'));
    expect(result.map((e) => e.id)).toEqual(ids);
    expect(peakRowsRead(reads, 'FROM memories')).toBeLessThanOrEqual(READ_PAGE_ROWS + 1);
  });

  it('reads the unprofiled topic summaries in pages', async () => {
    const { root, ids } = seeded(false, { dagLevel: DAG_LEVEL.topic });
    const { result, reads } = await recordStatementsAsync(async () => await loadAllL2Summaries(root));
    expect(result.map((e) => e.id)).toEqual(ids);
    expect(peakRowsRead(reads, 'dag_parent_id IS NULL')).toBeLessThanOrEqual(READ_PAGE_ROWS + 1);
  });
});

const VALUE = 'The deploy window is Friday afternoon';
// Holders past the first unfilled page of each table, and one on it as the conflict's loser.
const HOLDERS = [3, READ_PAGE_ROWS + 5, ROWS - 3];

function onDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** A store migrated to v65 and not yet slept: more than two pages of unfilled rows in each table. */
function unfilled() {
  const root = makeRoot('unfilled-walk');
  roots.push(root);
  const text = (i: number, row: string) => (HOLDERS.includes(i) ? VALUE : `${row} ${i}`);
  const live = Array.from({ length: ROWS }, (_, i) => ({
    ...createMemory(text(i, 'walk row')),
    id: `mem_w${String(i).padStart(5, '0')}`,
    created: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(),
  }));
  writeEntriesTogether(root, live);
  const dormant = Array.from({ length: ROWS }, (_, i) => ({
    ...createMemory(text(i, 'dormant row')),
    id: `mem_d${String(i).padStart(5, '0')}`,
  }));
  onDb(root, (db) => {
    db.exec('BEGIN');
    for (const entry of dormant) {
      insertDormantRow(db, { entry, strength: 0.1, reason: 'decay', dormantAt: '2026-03-01T00:00:00.000Z' });
    }
    db.exec('COMMIT');
    db.exec('UPDATE memories SET rejection_digest = NULL; UPDATE dormant_memories SET rejection_digest = NULL');
    db.exec('DELETE FROM held_text_digests');
  });
  const pick = (rows: readonly MemoryEntry[]) => HOLDERS.map((i) => rows[i].id);
  return { root, live: pick(live), dormant: pick(dormant), keep: live[1].id };
}

describe('the unfilled rows past one page', () => {
  it('reject removes every live and dormant holder', async () => {
    const { root, live, dormant } = unfilled();
    const applied = await sqliteStore(root).rejections.apply({
      tenantId: 'default',
      actor: 'tester',
      reason: 'wrong',
      value: VALUE,
      ownScope: null,
    });
    expect([...applied.removedIds].sort()).toEqual([...live, ...dormant].sort());
    for (const id of dormant) expect(onDb(root, (db) => readDormantSnapshot(db, 'default', id))).toBeNull();
  });

  it('resolve with reject removes the live copies on later pages', async () => {
    const { root, live, keep } = unfilled();
    const [loser, ...copies] = live;
    replaceDetectedConflicts(root, [{ memory_a_id: keep, memory_b_id: loser, reason: 'r', score: 0.9 }]);
    const [conflict] = await listMemoryConflicts(root, 'open');
    const resolved = await sqliteStore(root).conflicts.resolve('default', {
      conflictId: conflict.id,
      keep: { id: keep, scope: null },
      loser: { id: loser, scope: null },
      fate: { kind: 'reject', ownScope: null },
      actor: 'tester',
      reason: 'wrong',
      at: '2026-03-01T00:00:00.000Z',
    });
    expect(resolved).toBe(true);
    for (const id of copies) expect(readEntry(root, id)).toBeNull();
    expect(readEntry(root, keep)).not.toBeNull();
  });

  it('the fill leaves no row without a digest', () => {
    const { root } = unfilled();
    expect(onDb(root, fillRejectionDigests)).toBe(ROWS * 2);
    // SAFETY: an aggregate with no GROUP BY answers one row with an INTEGER n.
    const left = onDb(
      root,
      (db) =>
        db
          .prepare(
            'SELECT (SELECT COUNT(*) FROM memories WHERE rejection_digest IS NULL) + ' +
              '(SELECT COUNT(*) FROM dormant_memories WHERE rejection_digest IS NULL) AS n',
          )
          .get() as { n: number },
    );
    expect(left.n).toBe(0);
  });
});
