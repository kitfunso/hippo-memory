// A connection outside a server checkpoints inside its own commit at SQLite's default of 1,000 WAL pages, so a long
// write pays the checkpoint's two disk flushes once per 1,000 pages, not once per 100.
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeHippoDb, getHippoDbPath, openHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';

const PAGE_BYTES = 4096;

describe('a store connection outside a server', () => {
  it('copies nothing into hippo.db until its WAL holds 1,000 pages, then checkpoints in the next commit', () => {
    const root = makeRoot('wal-inline');
    const file = getHippoDbPath(root);
    const walPages = (): number => statSync(`${file}-wal`).size / PAGE_BYTES;
    const db = openHippoDb(root);
    try {
      db.exec('CREATE TABLE filler (body BLOB)');
      const before = readFileSync(file);
      const insert = db.prepare('INSERT INTO filler VALUES (randomblob(?))');
      while (walPages() < 950) insert.run(16 * PAGE_BYTES);
      expect(readFileSync(file).equals(before)).toBe(true);
      while (walPages() < 1050 && readFileSync(file).equals(before)) insert.run(16 * PAGE_BYTES);
      expect(readFileSync(file).equals(before)).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });
});
