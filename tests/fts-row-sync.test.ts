import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deleteEntry, initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-fts-sync-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
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
    const entry = createMemory('fresh row gets one fts row');
    writeEntry(root, entry);
    expect(ftsContents(entry.id)).toEqual(['fresh row gets one fts row']);
  });

  it('rewriting a memory replaces its full-text row instead of adding a second', () => {
    const entry = createMemory('first version');
    writeEntry(root, entry);
    writeEntry(root, { ...entry, content: 'second version' });
    expect(ftsContents(entry.id)).toEqual(['second version']);
  });

  it('deleting then rewriting the same id leaves one full-text row', () => {
    const entry = createMemory('before delete');
    writeEntry(root, entry);
    expect(deleteEntry(root, entry.id)).toBe(true);
    writeEntry(root, { ...entry, content: 'after delete' });
    expect(ftsContents(entry.id)).toEqual(['after delete']);
  });
});
