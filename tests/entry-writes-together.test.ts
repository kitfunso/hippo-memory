import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { writeEntriesSeparately } from '../src/store/entry-writes.js';
import { onHandle, openStore } from '../src/store/open.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';

describe('writeEntriesSeparately', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes every row', () => {
    const root = makeRoot('entry-writes-batch');
    roots.push(root);
    const entries = ['alpha', 'beta', 'gamma'].map((text) => createMemory(text));
    writeEntriesSeparately(root, entries);
    expect(loadAllEntries(root, 'default').map((e) => e.content).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('commits the rows in one transaction, so a failing last row leaves none', () => {
    const root = makeRoot('entry-writes-batch-atomic');
    roots.push(root);
    onHandle(root, (db) => {
      db.exec(`CREATE TRIGGER poison BEFORE INSERT ON memories WHEN NEW.content = 'poison'
        BEGIN SELECT RAISE(ABORT, 'poisoned row'); END`);
    }, openStore);
    const entries = ['alpha', 'beta', 'poison'].map((text) => createMemory(text));
    expect(() => writeEntriesSeparately(root, entries)).toThrow(/poisoned row/);
    expect(loadAllEntries(root, 'default')).toHaveLength(0);
  });
});
