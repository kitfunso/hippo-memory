// The transaction each entry write runs in: a batch lands all or none, and a strengthen inside the
// caller's transaction neither commits it nor hides a failure from it.
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSyncLike } from '../../src/db/index.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { strengthenRetrieved, writeEntriesTogether } from '../../src/store/sqlite/entries/entry-writes.js';
import { openStore } from '../../src/store/sqlite/runtime/handles.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { onHandle, storeFilesOf } from '../_helpers/test-session.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});
const { writeEntry } = sessionPerTest();

const NOW = new Date('2026-06-01T00:00:00Z');
const RULES = { strength: PRODUCTION_STRENGTH, clock: () => NOW };
const OPTS = { tenantId: 'default', recallBoostAblated: false };

function seeded(): { root: string; id: string } {
  const root = makeRoot('entry-write-tiers');
  roots.push(root);
  const entry = createMemory('the deploy runs on fridays after the freeze window closes');
  writeEntry(root, entry);
  return { root, id: entry.id };
}

function retrievals(db: DatabaseSyncLike, id: string): number | undefined {
  // SAFETY: the query selects the one column the row type names.
  const row = db.prepare('SELECT retrieval_count FROM memories WHERE id = ?').get(id) as
    | { retrieval_count: number }
    | undefined;
  return row?.retrieval_count;
}

const stored = (root: string, id: string): number | undefined => onHandle(root, (db) => retrievals(db, id), openStore);

describe('writeEntriesTogether', () => {
  it('lands all or none: a refused row in the batch undoes the good one before it', () => {
    const { root, id } = seeded();
    const fresh = createMemory('a fresh row that must not land alone in a failed batch');
    // Another tenant's copy of a held id is refused, after `fresh` was written in the same batch.
    const foreign = { ...createMemory('a copy of an id another tenant holds'), id, tenantId: 'other' };
    expect(() =>
      onHandle(root, (db) => writeEntriesTogether(db, storeFilesOf(root), [fresh, foreign]), openStore),
    ).toThrow();
    expect(stored(root, fresh.id)).toBeUndefined();
  });
});

describe('strengthenRetrieved in the caller transaction', () => {
  it('bumps the row inside it and leaves the commit to the caller, whose rollback undoes it', () => {
    const { root, id } = seeded();
    onHandle(
      root,
      (db) => {
        db.exec('BEGIN IMMEDIATE');
        expect([...strengthenRetrieved({ inTx: db }, [id], OPTS, RULES)]).toEqual([id]);
        expect(retrievals(db, id)).toBe(1);
        db.exec('ROLLBACK');
      },
      openStore,
    );
    expect(stored(root, id)).toBe(0);
  });

  it('throws a failed write for the caller to undo', () => {
    const { root, id } = seeded();
    onHandle(
      root,
      (db) => {
        db.exec(
          "CREATE TEMP TRIGGER refuse_update BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'refused'); END",
        );
        db.exec('BEGIN IMMEDIATE');
        expect(() => strengthenRetrieved({ inTx: db }, [id], OPTS, RULES)).toThrow(/refused/);
        db.exec('ROLLBACK');
      },
      openStore,
    );
  });
});
