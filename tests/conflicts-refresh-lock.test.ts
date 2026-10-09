// Sleep's conflict refresh reads every memory before it takes the write lock, and its row writes never overwrite a value
// another writer set after that read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { replaceDetectedConflicts } from '../src/store/conflicts.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

interface StatementProto {
  run(...params: unknown[]): object;
  get(...params: unknown[]): object | undefined;
  all(...params: unknown[]): object[];
  iterate(...params: unknown[]): Iterable<object>;
}
// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike, and StatementSync is what its prepare returns.
const { DatabaseSync, StatementSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: { prototype: DatabaseSyncLike };
  StatementSync: { prototype: StatementProto };
};

const NOW = '2026-06-01T12:00:00.000Z';
const STORE_ROWS = 2_000;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A store of `n` rows, all copies of one written row, so the seeding costs one statement. */
function bulkStore(n: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-conflict-lock-'));
  roots.push(root);
  initStore(root);
  writeEntry(root, { ...createMemory('the deploy runs on Tuesdays'), id: 'mem_bulk_0' });
  const db = openHippoDb(root);
  try {
    // SAFETY: pragma_table_info yields one row per column with its name.
    const columns = (db.prepare(`SELECT name FROM pragma_table_info('memories') WHERE name != 'id'`).all() as Array<{ name: string }>).map((c) => c.name);
    db.exec(`
      WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${n - 1})
      INSERT INTO memories(id, ${columns.join(', ')}) SELECT 'mem_bulk_' || k.i, ${columns.join(', ')} FROM memories, k
    `);
  } finally {
    closeHippoDb(db);
  }
  return root;
}

function refsOf(root: string, id: string): string | null {
  const db = openHippoDb(root);
  try {
    // SAFETY: SELECT of one nullable TEXT column.
    return (db.prepare(`SELECT conflicts_with_json AS refs FROM memories WHERE id = ?`).get(id) as { refs: string | null }).refs;
  } finally {
    closeHippoDb(db);
  }
}

const pair = (a: number, b: number) => ({ memory_a_id: `mem_bulk_${a}`, memory_b_id: `mem_bulk_${b}`, reason: 'opposite values', score: 0.9 });

describe('conflict refresh', () => {
  it('touches only the conflicting rows under the write lock, however large the store', () => {
    const root = bulkStore(STORE_ROWS);
    let locked = false;
    let lockSeen = false;
    let commits = 0;
    // Statements run plus rows read while the lock is held: a count, so no runner is too slow for it.
    let touchedUnderLock = 0;
    const { exec } = DatabaseSync.prototype;
    const { run, get, all, iterate } = StatementSync.prototype;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSyncLike, sql: string) {
      exec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE') { locked = true; lockSeen = true; }
      if (sql === 'COMMIT') { locked = false; commits++; }
    });
    vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (this: StatementProto, ...params: unknown[]) {
      if (locked) touchedUnderLock++;
      return run.apply(this, params);
    });
    vi.spyOn(StatementSync.prototype, 'get').mockImplementation(function (this: StatementProto, ...params: unknown[]) {
      if (locked) touchedUnderLock++;
      return get.apply(this, params);
    });
    vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementProto, ...params: unknown[]) {
      const rows = all.apply(this, params);
      if (locked) touchedUnderLock += rows.length;
      return rows;
    });
    vi.spyOn(StatementSync.prototype, 'iterate').mockImplementation(function* (this: StatementProto, ...params: unknown[]) {
      for (const row of iterate.apply(this, params)) {
        if (locked) touchedUnderLock++;
        yield row;
      }
    });

    replaceDetectedConflicts(root, Array.from({ length: 10 }, (_, i) => pair(2 * i + 1, 2 * i + 2)), NOW);
    vi.restoreAllMocks();

    expect(commits).toBe(1);
    expect(lockSeen).toBe(true);
    // Ten pairs need a few dozen; a pass over the memories table inside the lock adds every one of its rows.
    expect(touchedUnderLock).toBeLessThan(STORE_ROWS / 10);
    expect(refsOf(root, 'mem_bulk_1')).toBe('["mem_bulk_2"]');
    expect(refsOf(root, 'mem_bulk_2')).toBe('["mem_bulk_1"]');
    expect(refsOf(root, 'mem_bulk_21')).toBe('[]');
  });

  it('keeps a value another writer set between the read and the write', () => {
    const root = bulkStore(4);
    const { exec } = DatabaseSync.prototype;
    let injected = false;
    // The other writer lands once the refresh has read the table and not yet taken the write lock.
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSyncLike, sql: string) {
      if (sql === 'BEGIN IMMEDIATE' && !injected) {
        injected = true;
        const other = openHippoDb(root);
        try {
          other.prepare(`UPDATE memories SET conflicts_with_json = '["mem_bulk_3"]' WHERE id = 'mem_bulk_1'`).run();
        } finally {
          closeHippoDb(other);
        }
      }
      exec.call(this, sql);
    });

    replaceDetectedConflicts(root, [pair(1, 2)], NOW);
    vi.restoreAllMocks();

    expect(injected).toBe(true);
    expect(refsOf(root, 'mem_bulk_1')).toBe('["mem_bulk_3"]');
    expect(refsOf(root, 'mem_bulk_2')).toBe('["mem_bulk_1"]');
  });
});
