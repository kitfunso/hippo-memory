// A broken full-text index never fails a write or a search, but it says so: warn once per kind of failure, then stay quiet.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { loadSearchEntries } from '../src/store/search-rows.js';
import { getHippoDbPath, withSharedStoreHandles, type DatabaseSyncLike } from '../src/db.js';
import { resetLogOnce } from '../src/log.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

let root: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

/** Swap the FTS5 table for a plain one that refuses `poison` text and every delete, while the store still reports FTS on. */
function breakFtsIndex(): void {
  const db = new DatabaseSync(getHippoDbPath(root));
  db.exec(`
    DROP TABLE memories_fts;
    CREATE TABLE memories_fts(id TEXT, content TEXT CHECK (content NOT LIKE '%poison%'), tags TEXT);
    CREATE TRIGGER memories_fts_no_delete BEFORE DELETE ON memories_fts BEGIN SELECT RAISE(ABORT, 'fts delete refused'); END;
  `);
  db.close();
}

function linesWith(text: string): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(text));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-fts-fail-'));
  initStore(root);
  breakFtsIndex();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  resetLogOnce();
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('FTS failure logging', () => {
  it('warns once when MATCH fails for a reason other than query syntax, and still finds the row by LIKE', () => {
    writeEntry(root, createMemory('alpha keyword note'));
    expect(loadSearchEntries(root, 'alpha').map((e) => e.content)).toEqual(['alpha keyword note']);
    loadSearchEntries(root, 'keyword');
    const warnings = linesWith('FTS search failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[hippo\] warn: /);
  });

  // One shared handle, because a fresh open re-checks the index, finds it out of step and turns FTS off.
  it('warns once when an FTS delete fails, and the memory row is still deleted', async () => {
    const a = createMemory('first row to forget');
    const b = createMemory('second row to forget');
    writeEntry(root, a);
    writeEntry(root, b);
    await withSharedStoreHandles(() => {
      expect(deleteEntry(root, a.id)).toBe(true);
      expect(deleteEntry(root, b.id)).toBe(true);
    });
    const warnings = linesWith('FTS index delete failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('fts delete refused');
  });

  it('warns once when an FTS insert fails, then logs later failures only at debug', async () => {
    await withSharedStoreHandles(() => {
      writeEntry(root, createMemory('poison one'));
      writeEntry(root, createMemory('poison two'));
      expect(linesWith('FTS index update failed')).toHaveLength(1);
      process.env.HIPPO_LOG = 'debug';
      try {
        writeEntry(root, createMemory('poison three'));
      } finally {
        delete process.env.HIPPO_LOG;
      }
    });
    const all = linesWith('FTS index update failed');
    expect(all).toHaveLength(2);
    expect(all[1]).toMatch(/^\[hippo\] debug: /);
  });
});
