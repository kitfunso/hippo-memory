// Tagging a batch commits once, however many rows it tags, and tags the same rows the per-row writes did.
import { beforeEach, describe, expect, it } from 'vitest';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { readEntry } from '../_helpers/root-forms.js';

const TAG = 'churn-stale';
let root: string;

beforeEach(() => {
  root = makeRoot('add-tag-batch');
});

function seed(count: number, opts: { tenantId?: string; tags?: string[] } = {}): string[] {
  const db = openHippoDb(root);
  try {
    return Array.from({ length: count }, (_, i) => {
      const entry = createMemory(`tag batch row ${i} for ${opts.tenantId ?? 'default'}`, opts);
      writeEntryDbOnly(db, entry);
      return entry.id;
    });
  } finally {
    closeHippoDb(db);
  }
}

const tagAll = (ids: readonly string[]) =>
  recordStatements(() => sqliteSyncStore(root).learning.addTagToEntries('default', ids, TAG)).statements;

describe('addTagToEntries', () => {
  it('commits one transaction for one row and for many', () => {
    const [one] = seed(1);
    const many = seed(9);

    expect(countMatching(tagAll([one]), /^BEGIN IMMEDIATE$/)).toBe(1);
    expect(countMatching(tagAll(many), /^BEGIN IMMEDIATE$/)).toBe(1);
    for (const id of [one, ...many]) expect(readEntry(root, id)?.tags).toContain(TAG);
  });

  it('skips an id the tenant does not hold and a row already tagged, and writes nothing when none is left', () => {
    const [plain] = seed(1);
    const [tagged] = seed(1, { tags: ['kept', TAG] });
    const [foreign] = seed(1, { tenantId: 'other' });

    tagAll([plain, tagged, foreign, 'missing-id', plain]);

    expect(readEntry(root, plain)?.tags.filter((t) => t === TAG)).toEqual([TAG]);
    expect(readEntry(root, tagged)?.tags).toEqual(['kept', TAG]);
    expect(readEntry(root, foreign)?.tags).not.toContain(TAG);
    expect(countMatching(tagAll([tagged, foreign]), 'BEGIN')).toBe(0);
  });
});
