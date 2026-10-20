// The importer's duplicate check against a real store: spacing, sleep-merged rows, other scripts, symbols and FTS
// syntax answer as the whole-store key set did, with the full-text index in sync or not, reading only rows that match.
import { beforeEach, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, setFtsInSync, type DatabaseSyncLike } from '../../src/db/index.js';
import { importEntries } from '../../src/entry/importers.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

const LONG = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
const STORED = [
  'Always run the migrations before seeding the database',
  'Le café est fermé le lundi après-midi',
  'Сервер перезапускается каждую ночь в полночь',
  '--- *** ??? !!! ### ---',
  'Search "NEAR" AND OR NOT * ^ col: (paren) works',
  '🙂🙂🙂 ✓✓✓ →→→',
  LONG,
  '  Prefer   small  pull requests\nwith one topic each  ',
];

/** Chunk, and whether the store already holds it word for word, spacing aside. */
const CHUNKS: ReadonlyArray<readonly [string, boolean]> = [
  ['Always   run the migrations\nbefore seeding the database', true],
  ['Rebuild the search index after a schema change', true],
  ['Pin the node version in the CI workflow file so that builds stay reproducible', true],
  ['Use the staging bucket for large uploads only', true],
  ['Le café est fermé le lundi après-midi', true],
  ['Le cafe est ferme le lundi apres-midi', false],
  ['Сервер перезапускается каждую ночь в полночь', true],
  ['--- *** ??? !!! ### ---', true],
  ['The acme deploy key rotates every ninety days', false],
  ['Old advice: restart the worker on every deploy', true],
  ['Search "NEAR" AND OR NOT * ^ col: (paren) works', true],
  ['🙂🙂🙂 ✓✓✓ →→→', true],
  [`${LONG} extra`, false],
  [LONG.replace(/ /g, '\n  '), true],
  ['Prefer small pull requests with one topic each', true],
  ['Rebuild the search index', false],
  ['A brand new lesson about caching layers', false],
];
const NEW = CHUNKS.filter(([, held]) => !held).map(([text]) => text);
const REPEAT = 'A brand new lesson about caching layers';

let root: string;
beforeEach(() => {
  root = makeRoot('import-dedupe-reads');
});

function withDb<R>(fn: (db: DatabaseSyncLike) => R): R {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

const row = (content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { layer: Layer.Semantic }),
  ...extra,
});

function write(rows: readonly MemoryEntry[]): void {
  withDb((db) => {
    db.exec('BEGIN');
    for (const entry of rows) writeEntryDbOnly(db, entry);
    db.exec('COMMIT');
  });
}

function seed(): void {
  const merge: Partial<MemoryEntry> = { source: 'consolidation' };
  const parts = [
    'Rebuild the search index after a schema change',
    'Pin the node version in the CI workflow file\nso that builds stay reproducible',
  ];
  write([
    ...STORED.map((text) => row(text)),
    row(mergedText('[Consolidated from 2 related memories, newest first]', parts), merge),
    row('[Consolidated from 2 related memories]\n\nUse the staging bucket for large uploads only', merge),
    row('The acme deploy key rotates every ninety days', { tenantId: 'acme' }),
    row('Old advice: restart the worker on every deploy', { supersededBy: 'mem_newer' }),
  ]);
}

const chunks = (): string[] => [...CHUNKS.map(([text]) => text), REPEAT, 'short'];
const run = (dryRun: boolean, tenantId: string | undefined = 'default') =>
  importEntries(chunks(), 'import:file', ['imported'], { hippoRoot: root, dryRun, tenantId });

describe('import duplicate check', () => {
  it.each([false, true])('skips exactly the held texts with the index in sync: %s', (inSync) => {
    seed();
    withDb((db) => setFtsInSync(db, inSync));

    const { result, statements } = recordStatements(() => run(true));

    // The symbol and emoji chunks name no letter or digit the index is sure to hold, so they take the word scan.
    expect(countMatching(statements, 'memories_fts MATCH')).toBe(inSync ? CHUNKS.length - 1 : 0);
    expect(result.entries.map((e) => e.content)).toEqual([...NEW, REPEAT]);
    expect([result.total, result.imported, result.skipped]).toEqual([CHUNKS.length + 1, NEW.length + 1, 13]);
  });

  it('a real run also skips a chunk it imported a moment ago, and a host-wide one sees every tenant', () => {
    seed();

    const real = run(false);
    expect(real.entries.map((e) => e.content)).toEqual(NEW);
    expect([real.total, real.imported, real.skipped]).toEqual([CHUNKS.length + 1, NEW.length, 14]);

    const hostWide = run(true, undefined);
    expect(hostWide.imported).toBe(0);
  });

  it('reads no more rows with 500 stored rows that hold none of the chunks', () => {
    const rowsRead = (inSync: boolean): number => {
      withDb((db) => setFtsInSync(db, inSync));
      return recordStatements(() => run(true)).rowsRead;
    };
    seed();
    const before = [rowsRead(true), rowsRead(false)];

    write(Array.from({ length: 500 }, (_, k) => row(`xyzzy plugh ${k}`)));

    expect([rowsRead(true), rowsRead(false)]).toEqual(before);
  });
});
