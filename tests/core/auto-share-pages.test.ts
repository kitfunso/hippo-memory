// autoShare over a store larger than one page: the same picks, skips and writes as one whole read gave.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { autoShare } from '../../src/domain/sharing/share.js';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

type AutoShareStats = NonNullable<NonNullable<Parameters<typeof autoShare>[2]>['stats']>;

const ROWS = 1100;
const text = (label: string): string => `${label}: the step needs its flag or the command silently does nothing`;

let root: string;

beforeEach(() => {
  const tmp = makeRoot('autoshare-pages', { init: false });
  vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
  initTestStore(getGlobalRoot());
  root = join(tmp, 'proj', '.hippo');
  initTestStore(root);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Rows that differ from a plain filler row, by their place in store order. */
const SPECIAL: ReadonlyMap<number, Partial<MemoryEntry>> = new Map<number, Partial<MemoryEntry>>([
  [3, { content: text('first error'), tags: ['error'] }],
  [499, { content: text('already global'), tags: ['error'] }],
  [500, { content: text('page edge error'), tags: ['error'] }],
  [501, { content: text('inside a global merge'), tags: ['error'] }],
  [750, { content: text('git seed'), tags: ['git-learned', 'error'] }],
  [900, { content: 'aws creds AKIAIOSFODNN7EXAMPLE for the deploy user', tags: ['error'] }],
  [1050, { content: text('pinned lesson'), pinned: true }],
]);

/** One write transaction and no mirrors: the walk reads rows only. */
function seedLocal(): string[] {
  const ids: string[] = [];
  const db = openHippoDb(root);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < ROWS; i++) {
      const extra = SPECIAL.get(i) ?? {};
      const base = createMemory(extra.content ?? text(`filler ${i}`), {
        tags: extra.tags ?? [],
        emotionalValence: 'neutral',
      });
      const created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      writeEntryDbOnly(db, { ...base, ...extra, created });
      ids.push(base.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    closeHippoDb(db);
  }
  return ids;
}

function seedGlobal(): void {
  const spaced = createMemory(`  ${text('already global').replace(/ /g, '   ')}  `, { tenantId: 'other' });
  writeEntry(getGlobalRoot(), spaced);
  const merged = createMemory(
    mergedText('[Consolidated from 2 related memories, newest first]', [
      text('inside a global merge'),
      'a different lesson',
    ]),
    { source: 'consolidation', layer: Layer.Semantic },
  );
  writeEntry(getGlobalRoot(), merged);
}

const at = (ids: readonly string[], ...places: number[]): string[] => places.map((i) => ids[i]);

describe('autoShare across pages', () => {
  it('picks the signal rows in store order and skips global copies, git seeds and secrets', async () => {
    const ids = seedLocal();
    seedGlobal();
    const stats: AutoShareStats = { secretSkipped: 0 };

    const picked = await autoShare(...sharingStores(root), { dryRun: true, tenantId: 'default', stats });

    expect(picked.map((e) => e.id)).toEqual(at(ids, 3, 500, 1050));
    expect(stats).toEqual({ secretSkipped: 1, neverAutoShareSkipped: 1 });
  });

  it('below the neutral score picks every other row of the tenant in store order', async () => {
    const ids = seedLocal();
    seedGlobal();
    const skipped = new Set(at(ids, 499, 501, 750, 900));

    const picked = await autoShare(...sharingStores(root), { minScore: 0.3, dryRun: true, tenantId: 'default' });

    expect(picked.map((e) => e.id)).toEqual(ids.filter((id) => !skipped.has(id)));
  });

  it('writes the picks to the global store, and a second run finds them there', async () => {
    const ids = seedLocal();
    seedGlobal();
    const stores = sharingStores(root);

    const shared = await autoShare(...stores, { tenantId: 'default' });

    const local = new Map(loadAllEntries(root, 'default').map((e) => [e.id, e.content]));
    expect(shared.map((e) => e.content)).toEqual(at(ids, 3, 500, 1050).map((id) => local.get(id)));
    const global = loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content);
    expect(global).toEqual(expect.arrayContaining(shared.map((e) => e.content)));
    expect(await autoShare(...stores, { tenantId: 'default' })).toEqual([]);
  });
});
