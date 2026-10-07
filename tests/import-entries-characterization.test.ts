// Pins importEntries' counts and ordering so its stage split cannot drift.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { importEntries } from '../src/importers/core.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const LONG = 'Deploy the importer only after the schema check passes. '.repeat(30);

describe('importEntries characterization', () => {
  it('truncates long chunks, skips short and duplicate ones, and dedups within a real batch', () => {
    root = makeRoot('import-entries');
    const result = importEntries(
      ['tiny', LONG, 'Always run the migration dry-run first.', 'Always run the migration dry-run first.'],
      'test-source',
      ['imported'],
      { hippoRoot: root, extraTags: ['extra', 'imported'] },
    );
    expect(result).toMatchObject({ total: 3, imported: 2, skipped: 2, rejected: 0, redacted: 0 });
    expect(result.entries.map((e) => e.content.length)).toEqual([1000, 39]);
    expect(result.entries[0].tags).toEqual(['imported', 'extra']);
    expect(loadAllEntries(root).map((e) => e.source).sort()).toEqual(['test-source', 'test-source']);
  });

  it('dry run writes nothing and does not dedup within the batch', () => {
    root = makeRoot('import-entries-dry');
    const chunk = 'Prefer small pull requests over large ones.';
    const result = importEntries([chunk, chunk], 'test-source', [], { hippoRoot: root, dryRun: true });
    expect(result).toMatchObject({ total: 2, imported: 2, skipped: 0, rejected: 0 });
    expect(loadAllEntries(root)).toEqual([]);
  });
});
