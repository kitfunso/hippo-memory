// Sleep's conflict refresh reads every memory before it takes the write lock, and its row writes never overwrite a value
// another writer set after that read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { initStore, openStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readConflictRefresh, replaceDetectedConflicts, writeConflictRefresh } from '../src/store/conflicts.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: { prototype: DatabaseSyncLike } };

const NOW = '2026-06-01T12:00:00.000Z';
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
  it('holds the write lock under 10 ms on a 20,000-row store', () => {
    const root = bulkStore(20_000);
    const holds: number[] = [];
    let begunAt = 0;
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSyncLike, sql: string) {
      exec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE') begunAt = performance.now();
      if (sql === 'COMMIT' && begunAt > 0) holds.push(performance.now() - begunAt);
    });

    replaceDetectedConflicts(root, Array.from({ length: 10 }, (_, i) => pair(2 * i + 1, 2 * i + 2)), NOW);
    vi.restoreAllMocks();

    expect(holds).toHaveLength(1);
    // A fifth of the 50 ms budget, so a read of the whole table inside the lock fails it even on a fast disk.
    expect(holds[0]).toBeLessThan(10);
    expect(refsOf(root, 'mem_bulk_1')).toBe('["mem_bulk_2"]');
    expect(refsOf(root, 'mem_bulk_2')).toBe('["mem_bulk_1"]');
    expect(refsOf(root, 'mem_bulk_21')).toBe('[]');
  }, 60_000);

  it('keeps a value another writer set between the read and the write', () => {
    const root = bulkStore(4);
    const db = openStore(root);
    try {
      const reads = readConflictRefresh(db);
      db.prepare(`UPDATE memories SET conflicts_with_json = '["mem_bulk_3"]' WHERE id = 'mem_bulk_1'`).run();

      const changed = writeConflictRefresh(db, reads, [pair(1, 2)], NOW);

      expect(changed).toEqual(['mem_bulk_2']);
    } finally {
      closeHippoDb(db);
    }
    expect(refsOf(root, 'mem_bulk_1')).toBe('["mem_bulk_3"]');
    expect(refsOf(root, 'mem_bulk_2')).toBe('["mem_bulk_1"]');
  });
});
