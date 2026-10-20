import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, setFtsInSync, type DatabaseSyncLike } from '../../src/db/index.js';
import { longestWord, mergedText, storedTextKeys, duplicateKey } from '../../src/base/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadTextsHoldingWords, writeEntriesTogether } from '../_helpers/root-forms.js';
import { recordStatements } from '../_helpers/count-statements.js';

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

describe('loadTextsHoldingWords through the full-text index', () => {
  let root: string;
  const words = LESSONS.map(longestWord);

  beforeEach(() => {
    root = makeStore('held-words').root;
    writeEntriesTogether(root, STORED);
    withDb(root, (db) => setFtsInSync(db, true));
  });

  it.each([true, false])('finds exactly the lessons a whole scan finds, index in sync: %s', (inSync) => {
    withDb(root, (db) => setFtsInSync(db, inSync));
    const keys = storedTextKeys(loadTextsHoldingWords(root, 'default', words));
    const whole = wholeScanKeys(root, words);
    expect(LESSONS.map((l) => keys.has(duplicateKey(l)))).toEqual(LESSONS.map((l) => whole.has(duplicateKey(l))));
    expect(LESSONS.map((l) => keys.has(duplicateKey(l)))).toEqual([true, true, true, true]);
  });

  it('asks the index, not a tenant scan, for words it can name', () => {
    const { statements } = recordStatements(() => loadTextsHoldingWords(root, 'default', words.slice(0, 2)));
    const held = statements.filter((sql) => sql.includes('instr(content'));
    expect(held).toHaveLength(1);
    // SAFETY: EXPLAIN QUERY PLAN answers id, parent, notused and detail for each step.
    const plan = withDb(root, (db) => db.prepare(`EXPLAIN QUERY PLAN ${held[0]}`).all() as Array<{ detail: string }>);
    expect(plan.map((p) => p.detail).filter((d) => /^SCAN memories(?!_fts)/.test(d))).toEqual([]);
  });

  it('reads the same rows when the store holds five times more rows without the words', () => {
    const named = words.slice(0, 2);
    const before = recordStatements(() => loadTextsHoldingWords(root, 'default', named));
    writeEntriesTogether(
      root,
      Array.from({ length: 5 * STORED.length }, (_, i) => row(`unrelated filler ${i}`)),
    );
    withDb(root, (db) => setFtsInSync(db, true));
    const after = recordStatements(() => loadTextsHoldingWords(root, 'default', named));
    expect(after.rowsRead).toBe(before.rowsRead);
    expect(after.statements.length).toBe(before.statements.length);
    expect(after.result.map((r) => r.content).sort()).toEqual(before.result.map((r) => r.content).sort());
  });
});
