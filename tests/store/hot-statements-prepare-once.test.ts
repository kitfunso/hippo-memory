// A statement a request runs is prepared once per handle, however many calls read it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { getMeta, setMeta } from '../../src/db/meta.js';
import { tableExists } from '../../src/db/tables.js';
import { makeRoot } from '../_helpers/make-root.js';

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement.
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: { prototype: { prepare(sql: string): object } } };

let db: DatabaseSyncLike;
beforeEach(() => {
  db = openHippoDb(makeRoot('hot-statements'));
});
afterEach(() => closeHippoDb(db));

function prepares(fn: () => void): string[] {
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare');
  try {
    fn();
    return spy.mock.calls.map(([text]) => text);
  } finally {
    spy.mockRestore();
  }
}

describe('hot db reads', () => {
  it('prepare getMeta, setMeta and tableExists once across many calls', () => {
    const texts = prepares(() => {
      for (let i = 0; i < 5; i++) {
        setMeta(db, 'k', String(i));
        expect(getMeta(db, 'k')).toBe(String(i));
        expect(tableExists(db, 'memories')).toBe(true);
      }
    });
    expect(texts).toHaveLength(3);
    expect(new Set(texts).size).toBe(3);
  });
});
