import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Card } from '../../src/base/records/card.js';
import { closeHippoDb, openHippoDb, RequestStores } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { cardDetailOf } from '../_helpers/card-detail.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { completeCard, createCard } from '../_helpers/root-forms.js';

const TENANT = 'default';
interface Preparer {
  prepare(sql: string): object;
}
// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement object.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: { prototype: Preparer } };
let root: string;
let session: RequestStores;
let store: ReturnType<typeof sqliteStore>;

beforeEach(() => {
  root = makeRoot('card-promotion');
  session = new RequestStores();
  store = sqliteStore(root, { session });
});

afterEach(() => {
  session.close();
});

async function toReview(id: string): Promise<void> {
  await store.cards.claim(TENANT, id, 'test-runtime');
  await store.cards.review(TENANT, id);
}

async function finish(id: string): Promise<void> {
  await toReview(id);
  await store.cards.complete(TENANT, id, 'success');
}

async function card(id: string): Promise<Card> {
  const found = (await store.cards.detail(TENANT, id))?.card;
  if (!found) throw new Error(`card ${id} is missing`);
  return found;
}

interface Family {
  readonly parent: string;
  readonly promotable: Set<string>;
  readonly others: Card[];
}

async function seedFamily(children: number): Promise<Family> {
  const parent = (await store.cards.create(TENANT, { title: 'parent' })).id;
  const doneParent = (await store.cards.create(TENANT, { title: 'done parent' })).id;
  const openParent = (await store.cards.create(TENANT, { title: 'open parent' })).id;
  const promotable = new Set<string>();
  const otherIds: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < children; i++) {
    const second = i % 4 === 3 ? [openParent] : i % 3 === 1 ? [doneParent] : [];
    ids.push((await store.cards.create(TENANT, { title: `child ${i}`, dependsOn: [parent, ...second] })).id);
  }
  await finish(doneParent);
  const db = openHippoDb(root);
  const toReady = db.prepare(
    "UPDATE cards SET status = 'ready', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'backlog'",
  );
  try {
    ids.forEach((id, i) => {
      if (i % 5 === 4) toReady.run(new Date().toISOString(), id, TENANT);
      if (i % 4 === 3 || i % 5 === 4) otherIds.push(id);
      else promotable.add(id);
    });
  } finally {
    closeHippoDb(db);
  }
  await toReview(parent);
  return { parent, promotable, others: await Promise.all(otherIds.map(card)) };
}

describe('completeCard child promotion', () => {
  it.each([1, 10, 100])(
    'promotes the unblocked backlog children of a parent with %i children, in card_deps order',
    async (children) => {
      const family = await seedFamily(children);
      const result = await store.cards.complete(TENANT, family.parent, 'success');

      const deps = (await cardDetailOf(root, TENANT, family.parent))?.deps;
      const inDepsOrder = (deps?.children ?? []).filter((id) => family.promotable.has(id));
      expect(result?.promotedChildren).toEqual(inDepsOrder);
      expect(result?.promotedChildren).toHaveLength(family.promotable.size);
      expect(result?.card.status).toBe('done');
      for (const id of family.promotable) {
        expect(await card(id)).toMatchObject({
          status: 'ready',
          leaseUntil: null,
          heartbeatAt: null,
          assigneeRuntime: null,
        });
      }
      expect(await Promise.all(family.others.map((before) => card(before.id)))).toEqual(family.others);
    },
  );

  it('promotes nothing when the parent is shelved', async () => {
    const family = await seedFamily(10);
    const result = await store.cards.complete(TENANT, family.parent, 'failure');
    expect(result?.promotedChildren).toEqual([]);
    const promotable = await Promise.all([...family.promotable].map((id) => card(id)));
    expect(promotable.map((child) => child.status)).toEqual([...family.promotable].map(() => 'backlog'));
  });

  it("leaves another tenant's child of the same parent id in backlog", async () => {
    const family = await seedFamily(3);
    const db = openHippoDb(root);
    try {
      db.prepare(`
        INSERT INTO cards (id, title, status, created_at, updated_at, tenant_id) VALUES ('card_other', 'other', 'backlog', 'x', 'x', 'tenant-b')
      `).run();
      db.prepare(
        `INSERT INTO card_deps (parent, child, tenant_id, created_at) VALUES (?, 'card_other', 'tenant-b', 'x')`,
      ).run(family.parent);
    } finally {
      closeHippoDb(db);
    }
    const result = await store.cards.complete(TENANT, family.parent, 'success');
    expect(result?.promotedChildren).toHaveLength(family.promotable.size);
    expect((await store.cards.detail('tenant-b', 'card_other'))?.card.status).toBe('backlog');
  });
});

function recordPrepares<T>(fn: () => T) {
  const prepared: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: Preparer, sql: string) {
    prepared.push(sql);
    return prepare.call(this, sql);
  });
  try {
    return { result: fn(), prepared };
  } finally {
    spy.mockRestore();
  }
}

describe('statements one completion prepares and runs', () => {
  it('do not grow with the child count: one read of the children and one update for all it promotes', async () => {
    const runs: { prepared: string[]; run: string[] }[] = [];
    for (const children of [1, 10, 100]) {
      const family = await seedFamily(children);
      const log = recordStatements(() => recordPrepares(() => completeCard(root, TENANT, family.parent, 'success')));
      expect((await log.result.result)?.promotedChildren).toHaveLength(family.promotable.size);
      runs.push({ prepared: log.result.prepared, run: log.statements });
    }
    expect(runs.map((r) => [r.prepared.length, r.run.length])).toEqual(
      runs.map(() => [runs[0].prepared.length, runs[0].run.length]),
    );
    for (const { prepared, run } of runs) {
      expect(countMatching(prepared, 'FROM card_deps')).toBe(1);
      expect(countMatching(run, 'FROM card_deps')).toBe(1);
      expect(countMatching(run, 'UPDATE cards SET status')).toBe(2);
    }
  });

  it('prepares the dependency insert of a new card once for 20 parents', async () => {
    const parents: string[] = [];
    for (let i = 0; i < 20; i++) parents.push((await store.cards.create(TENANT, { title: `parent ${i}` })).id);
    const log = recordStatements(() =>
      recordPrepares(() => createCard(root, TENANT, { title: 'child', dependsOn: parents })),
    );
    expect(countMatching(log.result.prepared, 'INSERT INTO card_deps')).toBe(1);
    expect(countMatching(log.statements, 'INSERT INTO card_deps')).toBe(20);
    const child = await log.result.result;
    expect(child.status).toBe('backlog');
    expect((await cardDetailOf(root, TENANT, child.id))?.deps.parents.sort()).toEqual([...parents].sort());
  });
});
