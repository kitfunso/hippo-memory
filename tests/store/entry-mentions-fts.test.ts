import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeEntry } from '../../src/store/entry-writes.js';
import { DatabaseSync } from '../../src/db/sqlite.js';
import { getMeta, setMeta } from '../../src/db/meta.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { invalidateMatching } from '../../src/learn/invalidation.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

const CONTENTS = [
  'Use the café cache for sessions',
  'Straße cache invalidation runs nightly',
  'CACHE, with punctuation: cache-key; naïve approach',
  'Plain ascii note about deploys and retries',
  'journal_mode WAL needs the express-js adapter',
  'Unrelated sentence about lunch',
];
const TARGETS = ['café', 'Straße', 'cache-key', 'express-js', 'journal_mode', 'naïve approach', 'ascii'];

function setFts(root: string, flag: '0' | '1'): void {
  const db = new DatabaseSync(join(root, 'hippo.db'));
  try {
    setMeta(db, 'fts5_available', flag);
  } finally {
    db.close();
  }
}

describe('loadEntriesMentioning on the FTS path', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('mentions');
    const db = new DatabaseSync(join(root, 'hippo.db'));
    try {
      expect(getMeta(db, 'fts5_available', '0')).toBe('1');
    } finally {
      db.close();
    }
    for (const content of CONTENTS) writeEntry(root, createMemory(content, { tags: ['Ops'] }));
  });

  it('matches the same rows for invalidation on both paths', () => {
    for (const from of TARGETS) {
      const target = { from, to: null, type: 'removal' as const };
      const viaFts = invalidateMatching(sqliteSyncStore(root).localFiles.learning, target, undefined, { dryRun: true });
      setFts(root, '0');
      const viaLike = invalidateMatching(sqliteSyncStore(root).localFiles.learning, target, undefined, {
        dryRun: true,
      });
      setFts(root, '1');
      expect(viaFts.targets.slice().sort()).toEqual(viaLike.targets.slice().sort());
    }
    const hit = invalidateMatching(
      sqliteSyncStore(root).localFiles.learning,
      { from: 'café', to: null, type: 'removal' },
      undefined,
      { dryRun: true },
    );
    expect(hit.targets).toHaveLength(1);
  });

  it('matches an exact tag through the tags column', () => {
    const result = invalidateMatching(
      sqliteSyncStore(root).localFiles.learning,
      { from: 'ops', to: null, type: 'removal' },
      undefined,
      { dryRun: true },
    );
    expect(result.targets).toHaveLength(CONTENTS.length);
  });
});
