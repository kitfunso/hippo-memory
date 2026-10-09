// A batch call clears the full-text rows it replaces with one delete, re-indexes only rows whose text changed,
// and never indexes an id twice, even when the index refuses the delete.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from '../src/db/sqlite.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { batchWriteAndDelete } from '../src/store/delete-and-batch.js';
import { getHippoDbPath, withSharedStoreHandles } from '../src/db/index.js';
import type { MemoryEntry } from '../src/core/memory.js';
import { resetLogOnce } from '../src/util/log.js';
import { countMatching, recordStatements } from './_helpers/count-statements.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const FTS_WRITE = /(?:INSERT INTO|DELETE FROM) memories_fts\b/;
const FTS_DELETE = /DELETE FROM memories_fts\b/;

let root: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-fts-set-delete-'));
  initStore(root);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  resetLogOnce();
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedRows(n: number, label = 'seed'): MemoryEntry[] {
  const rows = Array.from({ length: n }, (_, i) => createMemory(`${label} row ${i} sigma${i} about the deploy`));
  for (const row of rows) writeEntry(root, row);
  return rows;
}

/** Ids on a raw handle, so no store open re-checks or repairs the index first. */
function idsOf(sql: string): string[] {
  const db = new DatabaseSync(getHippoDbPath(root));
  try {
    // SAFETY: every caller's SQL selects one id column.
    return (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id).sort();
  } finally {
    db.close();
  }
}

/** The same plain stand-in as tests/store-fts-failure-logging.test.ts: it refuses every delete while the store still reports FTS on. */
function breakFtsIndex(): void {
  const db = new DatabaseSync(getHippoDbPath(root));
  db.exec(`
    DROP TABLE memories_fts;
    CREATE TABLE memories_fts(id TEXT, content TEXT, tags TEXT);
    CREATE TRIGGER memories_fts_no_delete BEFORE DELETE ON memories_fts BEGIN SELECT RAISE(ABORT, 'fts delete refused'); END;
  `);
  db.close();
}

function dormantRows(id: string): number {
  const db = new DatabaseSync(getHippoDbPath(root));
  try {
    // SAFETY: an aggregate SELECT returns exactly one row and COUNT(*) is an integer.
    return (db.prepare('SELECT COUNT(*) AS n FROM dormant_memories WHERE id = ?').get(id) as { n: number }).n;
  } finally {
    db.close();
  }
}

function linesWith(text: string): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(text));
}

const edited = (e: MemoryEntry): MemoryEntry => ({ ...e, content: `${e.content}, edited` });

describe('batchWriteAndDelete full-text upkeep', () => {
  it('clears every replaced full-text row with at most one delete', () => {
    const rows = seedRows(60);
    const inserts = Array.from({ length: 10 }, (_, i) => createMemory(`new batch row ${i} omega${i}`));
    const moves = rows.slice(50, 60).map((entry) => ({ entry, strength: 0.01, reason: 'decay' as const, dormantAt: new Date().toISOString() }));

    const { statements } = recordStatements(() =>
      batchWriteAndDelete(root, [...rows.slice(0, 30).map(edited), ...inserts], rows.slice(30, 40).map((e) => e.id), { dormant: moves }));

    expect(countMatching(statements, FTS_DELETE)).toBeLessThanOrEqual(1);
    expect(idsOf('SELECT id FROM memories_fts')).toEqual(idsOf('SELECT id FROM memories'));
    expect(idsOf('SELECT id FROM memories')).toHaveLength(50);
  });

  it('a write whose text and tags match the stored row touches no full-text row', () => {
    const [row] = seedRows(1);

    const { statements } = recordStatements(() => batchWriteAndDelete(root, [{ ...row!, strength: 0.5 }], []));

    expect(countMatching(statements, FTS_WRITE)).toBe(0);
  });

  it('a refused delete indexes no id twice and warns once that the delete failed', async () => {
    breakFtsIndex();
    const rows = seedRows(3, 'before');
    const inserts = [createMemory('a brand new row one'), createMemory('a brand new row two')];

    await withSharedStoreHandles(() => {
      batchWriteAndDelete(root, [...rows.map(edited), ...inserts], []);
    });

    const fts = idsOf('SELECT id FROM memories_fts');
    expect(new Set(fts).size).toBe(fts.length);
    expect(new Set(fts)).toEqual(new Set(idsOf('SELECT id FROM memories')));
    expect(linesWith('FTS index')).toHaveLength(1);
    expect(linesWith('FTS index delete failed')).toHaveLength(1);
  });

  it('a memory queued for a dormant move twice moves once', () => {
    const [row] = seedRows(1);
    const move = { entry: row!, strength: 0.01, reason: 'decay' as const, dormantAt: new Date().toISOString() };

    expect(batchWriteAndDelete(root, [], [], { dormant: [move, { ...move }] })).toEqual([row!.id]);

    expect(readEntry(root, row!.id)).toBeNull();
    expect(dormantRows(row!.id)).toBe(1);
  });

  it('an id written and deleted in one call keeps no full-text row', () => {
    const [row] = seedRows(1);

    batchWriteAndDelete(root, [edited(row!)], [row!.id]);

    expect(idsOf('SELECT id FROM memories')).toEqual([]);
    expect(idsOf('SELECT id FROM memories_fts')).toEqual([]);
  });
});
