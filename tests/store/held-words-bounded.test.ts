import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, setFtsInSync, type DatabaseSyncLike } from '../../src/db/index.js';
import { longestWord, mergedText, storedTextKeys, duplicateKey } from '../../src/base/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadTextsHolding, writeEntriesTogether } from '../_helpers/root-forms.js';
import { countMatching, peakRowsRead, recordStatements } from '../_helpers/count-statements.js';
import { bareText, SPACE_CODES } from '../../src/store/rules/copies.js';
import { chunked } from '../../src/base/util/chunked.js';

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

const row = (content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { tenantId: 'default' }),
  ...extra,
});

const LESSONS = [
  'deploys need the staging-gate flag',
  'never   rotate keys on a Friday',
  'კავშირი ქართული ტექსტი',
  'concat is not the same as join',
];

const STORED = [
  row('deploys need the staging-gate flag'),
  row('never rotate keys on a Friday'),
  row('კავშირი ქართული ტექსტი'),
  row('concatenation of unrelated words'),
  row(mergedText('Merged lessons', ['concat is not the same as join', 'other text']), { source: 'consolidation' }),
];

// Today's read: every tenant row holding a word anywhere in its text, team-visible.
function wholeScanKeys(root: string, words: readonly string[]): Set<string> {
  const rows = withDb(root, (db) =>
    db.prepare("SELECT content, source FROM memories WHERE tenant_id = 'default'").all(),
  );
  // SAFETY: the SELECT above names exactly these two columns.
  const held = (rows as Array<{ content: string; source: string }>).filter((r) =>
    words.some((w) => r.content.includes(w)),
  );
  return storedTextKeys(held);
}

describe('loadTextsHolding through the full-text index', () => {
  let root: string;
  const words = LESSONS;

  beforeEach(() => {
    root = makeStore('held-words').root;
    writeEntriesTogether(root, STORED);
    withDb(root, (db) => setFtsInSync(db, true));
  });

  it.each([true, false])('finds exactly the lessons a whole scan finds, index in sync: %s', (inSync) => {
    withDb(root, (db) => setFtsInSync(db, inSync));
    const keys = storedTextKeys(loadTextsHolding(root, 'default', words));
    const whole = wholeScanKeys(root, words.map(longestWord));
    expect(LESSONS.map((l) => keys.has(duplicateKey(l)))).toEqual(LESSONS.map((l) => whole.has(duplicateKey(l))));
    expect(LESSONS.map((l) => keys.has(duplicateKey(l)))).toEqual([true, true, true, true]);
  });

  it('asks the index, not a tenant scan, for texts it can name', () => {
    const { statements } = recordStatements(() => loadTextsHolding(root, 'default', words.slice(0, 2)));
    const held = statements.filter((sql) => sql.includes('memories_fts MATCH'));
    expect(held).toHaveLength(1);
    // SAFETY: EXPLAIN QUERY PLAN answers id, parent, notused and detail for each step.
    const plan = withDb(root, (db) => db.prepare(`EXPLAIN QUERY PLAN ${held[0]}`).all() as Array<{ detail: string }>);
    expect(plan.map((p) => p.detail).filter((d) => /^SCAN memories(?!_fts)/.test(d))).toEqual([]);
  });

  it('reads the same rows when the store holds five times more rows without the texts', () => {
    const named = words.slice(0, 2);
    const before = recordStatements(() => loadTextsHolding(root, 'default', named));
    writeEntriesTogether(
      root,
      Array.from({ length: 5 * STORED.length }, (_, i) => row(`unrelated filler ${i}`)),
    );
    withDb(root, (db) => setFtsInSync(db, true));
    const after = recordStatements(() => loadTextsHolding(root, 'default', named));
    expect(after.rowsRead).toBe(before.rowsRead);
    expect(after.statements.length).toBe(before.statements.length);
    expect(after.result.map((r) => r.content).sort()).toEqual(before.result.map((r) => r.content).sort());
  });
});

const TEXT = 'deploy the build first then tag';
const EVERY_SPACE = String.fromCodePoint(...SPACE_CODES);

describe('loadTextsHolding returns only copies', () => {
  let root: string;
  const copies = [
    row(TEXT.replaceAll(' ', EVERY_SPACE)),
    row(mergedText('Merged lessons', [TEXT, 'other text']), { source: 'consolidation' }),
  ];

  beforeEach(() => {
    root = makeStore('held-copies').root;
    const sharing = Array.from({ length: 50 }, (_, i) => row(`${TEXT} on step ${i}`));
    const nearMisses = [row(TEXT.toUpperCase()), row(`deploy the build first`), row(`${TEXT} now`)];
    writeEntriesTogether(root, [...sharing, ...nearMisses, ...copies]);
  });

  it.each([true, false])('reads 2 of 55 rows sharing its words, index in sync: %s', (inSync) => {
    withDb(root, (db) => setFtsInSync(db, inSync));
    const { result, reads } = recordStatements(() => loadTextsHolding(root, 'default', [TEXT]));
    expect(result.map((r) => r.content).sort()).toEqual(copies.map((c) => c.content).sort());
    expect(peakRowsRead(reads, 'json_each')).toBe(2);
    expect(storedTextKeys(result).has(duplicateKey(TEXT))).toBe(true);
  });
});

describe('loadTextsHolding statements', () => {
  it.each([
    [10, true],
    [1200, true],
    [10, false],
    [1200, false],
  ])('runs one statement per chunk of texts at %i texts, index in sync: %s', (n, inSync) => {
    const root = makeStore('held-chunks').root;
    writeEntriesTogether(root, [row('lesson 3 of the batch')]);
    withDb(root, (db) => setFtsInSync(db, inSync));
    const texts = Array.from({ length: n }, (_, i) => `lesson ${i} of the batch`);
    const { result, statements } = recordStatements(() => loadTextsHolding(root, 'default', texts));
    expect(countMatching(statements, 'json_each')).toBe(chunked(texts).length);
    expect(result.map((r) => r.content)).toEqual(['lesson 3 of the batch']);
  });
});

describe('SPACE_CODES', () => {
  it('lists every code point JavaScript reads as a space, and only those', () => {
    const spaces: number[] = [];
    for (let code = 0; code <= 0x10ffff; code++) if (/^\s$/u.test(String.fromCodePoint(code))) spaces.push(code);
    expect([...SPACE_CODES]).toEqual(spaces);
    expect(bareText(`a${EVERY_SPACE}b`)).toBe('ab');
  });
});
