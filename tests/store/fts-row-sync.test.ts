import { beforeEach, describe, expect, it } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { deleteEntry, writeEntry } from '../_helpers/root-forms.js';

let root: string;

beforeEach(() => {
  root = makeRoot('fts-sync');
});

function ftsContents(id: string): string[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: rows' shape matches the single `content` column selected.
    const rows = db.prepare(`SELECT content FROM memories_fts WHERE id = ?`).all(id) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } finally {
    closeHippoDb(db);
  }
}

describe('full-text row per memory', () => {
  it('a new memory gets exactly one full-text row', () => {
    const entry = createMemory('fresh row gets one fts row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);
    expect(ftsContents(entry.id)).toEqual(['fresh row gets one fts row']);
  });

  it('rewriting a memory replaces its full-text row instead of adding a second', () => {
    const entry = createMemory('first version', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);
    writeEntry(root, { ...entry, content: 'second version' });
    expect(ftsContents(entry.id)).toEqual(['second version']);
  });

  it('deleting then rewriting the same id leaves one full-text row', () => {
    const entry = createMemory('before delete', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);
    expect(deleteEntry(root, entry.id)).toBe(true);
    writeEntry(root, { ...entry, content: 'after delete' });
    expect(ftsContents(entry.id)).toEqual(['after delete']);
  });
});
