// Sync down asks the local store about each global row's id and text: the same copies as the whole local key set
// gave, with the local full-text index in sync or not, and no local row read that holds none of those texts.
import { beforeEach, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, setFtsInSync } from '../../src/db/index.js';
import { syncGlobalToLocal } from '../../src/domain/sharing/global-sync.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { sharingStores } from '../_helpers/sharing-stores.js';

const at = (i: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

let localRoot: string;
let globalRoot: string;
beforeEach(() => {
  localRoot = makeStore('global-sync-reads').root;
  globalRoot = makeRoot('global-sync-reads-global');
});

function write(root: string, rows: readonly MemoryEntry[]): void {
  const db = openHippoDb(root);
  try {
    db.exec('BEGIN');
    for (const entry of rows) writeEntryDbOnly(db, entry);
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
}

const row = (content: string, i: number, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { layer: Layer.Semantic }),
  originProject: '',
  created: at(i),
  ...extra,
});

/** The global rows in store order; the local store holds g[0] by id, g[1] by text, and g[9] inside a merged row. */
function seed(): MemoryEntry[] {
  const g = [
    row('Shared lesson zero about release tags', 0),
    row('Shared lesson one about caching', 1),
    row('Shared lesson two about retries', 2, { tenantId: 'acme' }),
    row('Shared lesson three imported from a note', 3, { source: 'agent-memory:claude-code:p-1/three.md#a' }),
    row('Shared lesson four about backups', 4),
    row('Shared lesson four about backups', 5),
    row('aws creds AKIAIOSFODNN7EXAMPLE for the deploy user', 6),
    row('Shared lesson seven from another project', 7, { originProject: 'other-project' }),
    row('Shared lesson eight  about   spacing', 8),
    row('Shared lesson nine held in a local merge', 9),
  ];
  write(globalRoot, g);
  write(localRoot, [
    { ...g[0], content: 'A local edit of lesson zero' },
    row('Shared lesson one about caching', 1),
    row('Shared lesson two about retries', 2),
    row('Shared lesson eight about spacing', 8),
    row(mergedText('[Consolidated from 2 related memories, newest first]', [g[9].content, 'another text']), 9, {
      source: 'consolidation',
    }),
  ]);
  return g;
}

const localFtsInSync = (inSync: boolean): void => {
  const db = openHippoDb(localRoot);
  try {
    setFtsInSync(db, inSync);
  } finally {
    closeHippoDb(db);
  }
};

describe('sync down from the global store', () => {
  it.each([false, true])('copies the rows held by neither id nor tenant and text, index in sync: %s', (inSync) => {
    const g = seed();
    localFtsInSync(inSync);

    expect(syncGlobalToLocal(...sharingStores(localRoot, globalRoot))).toBe(4);

    const local = new Map(
      [...loadAllEntries(localRoot, 'default'), ...loadAllEntries(localRoot, 'acme')].map((e) => [e.id, e]),
    );
    for (const copied of [g[2], g[4], g[8], g[9]]) expect(local.get(copied.id)?.content).toBe(copied.content);
    for (const skipped of [g[1], g[3], g[5], g[6], g[7]]) expect(local.has(skipped.id)).toBe(false);
    expect(local.get(g[0].id)?.content).toBe('A local edit of lesson zero');
  });

  it('reads no more rows with 300 local rows that hold none of the global texts', () => {
    const rowsRead = (bystanders: number): number => {
      localRoot = makeStore('global-sync-reads').root;
      globalRoot = makeRoot('global-sync-reads-global');
      seed();
      write(
        localRoot,
        Array.from({ length: bystanders }, (_, k) => row(`xyzzy plugh ${k}`, 100 + k)),
      );
      return recordStatements(() => syncGlobalToLocal(...sharingStores(localRoot, globalRoot))).rowsRead;
    };

    expect(rowsRead(300)).toBe(rowsRead(0));
  });
});
