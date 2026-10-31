import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { DatabaseSync } from '../src/db/sqlite.js';
import { getMeta, setMeta } from '../src/db/meta.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { deduplicateLesson } from '../src/learn/autolearn.js';
import { invalidateMatching } from '../src/learn/invalidation.js';

const CONTENTS = [
  'Use the café cache for sessions',
  'Straße cache invalidation runs nightly',
  'CACHE, with punctuation: cache-key; naïve approach',
  'Plain ascii note about deploys and retries',
  'journal_mode WAL needs the express-js adapter',
  'Unrelated sentence about lunch',
];
const LESSONS = [
  'Use the café cache for sessions',
  'cafe cache sessions',
  'Straße cache invalidation',
  'naive approach with cache-key',
  'deploys and retries note',
  'journal_mode WAL express-js adapter',
  '!!! ???',
];
const TARGETS = ['café', 'Straße', 'cache-key', 'express-js', 'journal_mode', 'naïve approach', 'ascii'];

function setFts(root: string, flag: '0' | '1'): void {
  const db = new DatabaseSync(join(root, 'hippo.db'));
  try { setMeta(db, 'fts5_available', flag); } finally { db.close(); }
}

describe('loadEntriesMentioning on the FTS path', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-mentions-'));
    initStore(root);
    const db = new DatabaseSync(join(root, 'hippo.db'));
    try { expect(getMeta(db, 'fts5_available', '0')).toBe('1'); } finally { db.close(); }
    for (const content of CONTENTS) writeEntry(root, createMemory(content, { tags: ['Ops'] }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds every near-duplicate the full read finds, with and without FTS5', () => {
    const everyRow = loadAllEntries(root);
    for (const lesson of LESSONS) {
      const expected = deduplicateLesson(everyRow, lesson, 0.3);
      expect(deduplicateLesson(root, lesson, 0.3)).toBe(expected);
      setFts(root, '0');
      expect(deduplicateLesson(root, lesson, 0.3)).toBe(expected);
      setFts(root, '1');
    }
  });

  it('matches the same rows for invalidation on both paths', () => {
    for (const from of TARGETS) {
      const target = { from, to: null, type: 'removal' as const };
      const viaFts = invalidateMatching(root, target, undefined, { dryRun: true });
      setFts(root, '0');
      const viaLike = invalidateMatching(root, target, undefined, { dryRun: true });
      setFts(root, '1');
      expect(viaFts.targets.slice().sort()).toEqual(viaLike.targets.slice().sort());
    }
    const hit = invalidateMatching(root, { from: 'café', to: null, type: 'removal' }, undefined, { dryRun: true });
    expect(hit.targets).toHaveLength(1);
  });

  it('matches an exact tag through the tags column', () => {
    const result = invalidateMatching(root, { from: 'ops', to: null, type: 'removal' }, undefined, { dryRun: true });
    expect(result.targets).toHaveLength(CONTENTS.length);
  });
});
