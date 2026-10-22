// A cached statement's SQL text is the same for every list length, so three ids and thirty prepare it once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { sqliteCards } from '../../src/store/sqlite/cards.js';
import type { OnHandle } from '../../src/store/sqlite/open.js';
import { makeRoot } from '../_helpers/make-root.js';

const TENANT = 'default';
// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: { prototype: { prepare(sql: string): object } };
};

let db: DatabaseSyncLike;
let cards: ReturnType<typeof sqliteCards>;
beforeEach(() => {
  const root = makeRoot('list-statements');
  db = openHippoDb(root);
  const on: OnHandle = (fn) => fn(db, { hippoRoot: root });
  cards = sqliteCards(on);
});
afterEach(() => closeHippoDb(db));

/** A parent whose completion promotes `children` backlog children, plus one card that waits on `children` open cards. */
async function promoteFamily(children: number): Promise<void> {
  const parent = (await cards.create(TENANT, { title: 'parent' })).id;
  const others: string[] = [];
  for (let i = 0; i < children; i++) others.push((await cards.create(TENANT, { title: `other ${i}` })).id);
  for (let i = 0; i < children; i++) await cards.create(TENANT, { title: `child ${i}`, dependsOn: [parent] });
  await cards.create(TENANT, { title: 'waits on all', dependsOn: others });
  await cards.claim(TENANT, parent, 'test-runtime');
  await cards.review(TENANT, parent);
  await cards.complete(TENANT, parent, 'success');
}

describe('list-bound card statements', () => {
  it('prepare the transition and parent-check statements once for 3 ids and for 30', async () => {
    await promoteFamily(3);
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      await promoteFamily(30);
      const freshPrepares = spy.mock.calls
        .map(([text]) => text)
        .filter((text) => /UPDATE cards SET status|FROM cards WHERE tenant_id = \? AND id/.test(text));
      expect(freshPrepares).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
