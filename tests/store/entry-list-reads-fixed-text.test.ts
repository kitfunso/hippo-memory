// A cached list read binds its list as one JSON param, so a short list and a long one share one prepared statement and
// still keep the same rows. Real store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { DEFAULT_HALF_LIFE_DAYS, createMemory, type EmotionalValence } from '../../src/base/memory/memory.js';
import {
  contentsWithTagAt,
  loadCurrentEntriesFromOriginsAt,
  loadEntriesWithSignalsAt,
} from '../../src/store/sqlite/entry-reads.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: { prototype: { prepare(sql: string): object } };
};

const TENANT = 'default';

function row(content: string, tag: string, originProject: string, emotionalValence: EmotionalValence) {
  const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT, tags: [tag] });
  return { ...entry, originProject, emotionalValence, source: 'cli' };
}

let db: DatabaseSyncLike;
beforeEach(() => {
  const root = makeRoot('entry-list-reads');
  writeEntriesTogether(root, [
    row('alpha row', 'alpha', 'p1', 'neutral'),
    row('beta row', 'beta', 'p2', 'neutral'),
    row('gamma row', 'gamma', 'p3', 'critical'),
    row('global row', 'alpha', '', 'neutral'),
  ]);
  db = openHippoDb(root);
});
afterEach(() => closeHippoDb(db));

/** What `read` returns for a short list and then a long one, and the SQL the long one had to prepare. */
interface ShortThenLong<T> {
  readonly short: T;
  readonly long: T;
  readonly prepared: string[];
}

function shortThenLong<T>(read: (long: boolean) => T): ShortThenLong<T> {
  const short = read(false);
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare');
  try {
    const long = read(true);
    return { short, long, prepared: spy.mock.calls.map(([text]) => text) };
  } finally {
    spy.mockRestore();
  }
}

const contents = (entries: ReadonlyArray<{ content: string }>): string[] => entries.map((e) => e.content).sort();

describe('cached list reads', () => {
  it('the signal page reads one statement for one tag and valence and for three', () => {
    const signals = (long: boolean) => ({
      tags: long ? ['alpha', 'beta', 'nope'] : ['beta'],
      valences: long ? ['critical', 'negative'] : ['critical'],
      sourcePrefix: 'zzz',
      minRetrievals: 1_000,
    });
    const r = shortThenLong((long) => loadEntriesWithSignalsAt(db, signals(long), TENANT, { limit: 10 }).entries);
    expect(r.prepared).toEqual([]);
    expect(contents(r.short)).toEqual(['beta row', 'gamma row']);
    expect(contents(r.long)).toEqual(['alpha row', 'beta row', 'gamma row', 'global row']);
  });

  it('origin-filtered reads read one statement for one origin and for three', () => {
    const origins = (long: boolean) => (long ? ['p1', 'p2', 'p9'] : ['p1']);
    const tagged = shortThenLong((long) => contentsWithTagAt(db, TENANT, 'alpha', origins(long)));
    expect(tagged.prepared).toEqual([]);
    expect(tagged.short.sort()).toEqual(['alpha row', 'global row']);
    const current = shortThenLong((long) => loadCurrentEntriesFromOriginsAt(db, TENANT, origins(long)));
    expect(current.prepared).toEqual([]);
    expect(contents(current.short)).toEqual(['alpha row']);
    expect(contents(current.long)).toEqual(['alpha row', 'beta row']);
    expect(loadCurrentEntriesFromOriginsAt(db, TENANT, [])).toEqual([]);
  });
});
