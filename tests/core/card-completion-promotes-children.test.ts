// Completing a card promotes exactly its backlog children whose parents are all done, in card_deps order, and touches no other child.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Card } from '../../src/base/records/card.js';
import { closeHippoDb, openHippoDb, outsideRequestStores } from '../../src/db/index.js';
import { cardDetailOf } from '../_helpers/card-detail.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { claimCard, completeCard, createCard, loadCard, reviewCard } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const TENANT = 'default';
interface Preparer {
  prepare(sql: string): object;
}
// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement object.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: { prototype: Preparer } };
let root: string;

beforeEach(() => {
  root = makeRoot('card-promotion');
});

async function toReview(id: string): Promise<void> {
  await claimCard(root, TENANT, id, 'test-runtime');
  await reviewCard(root, TENANT, id);
}

async function finish(id: string): Promise<void> {
  await toReview(id);
  await completeCard(root, TENANT, id, 'success');
}

async function card(id: string): Promise<Card> {
  const found = await loadCard(root, TENANT, id);
  if (!found) throw new Error(`card ${id} is missing`);
  return found;
}

interface Family {
  readonly parent: string;
  /** Children the completion must promote: each is in backlog and every parent of it is done once `parent` is. */
  readonly promotable: Set<string>;
  readonly others: Card[];
}

/** A parent in review with `children` children: every fourth waits on an open second parent, every fifth already left backlog, the rest are promotable. */
async function seedFamily(children: number): Promise<Family> {
  const parent = (await createCard(root, TENANT, { title: 'parent' })).id;
  const doneParent = (await createCard(root, TENANT, { title: 'done parent' })).id;
  const openParent = (await createCard(root, TENANT, { title: 'open parent' })).id;
  const promotable = new Set<string>();
  const otherIds: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < children; i++) {
    const second = i % 4 === 3 ? [openParent] : i % 3 === 1 ? [doneParent] : [];
    ids.push((await createCard(root, TENANT, { title: `child ${i}`, dependsOn: [parent, ...second] })).id);
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

// Each case writes a family of up to 100 cards and their dependency rows to a real store, one statement at a time.
describe('completeCard child promotion', () => {
  it.each([1, 10, 100])(
    'promotes the unblocked backlog children of a parent with %i children, in card_deps order',
    async (children) => {
      const family = await seedFamily(children);
      const result = await completeCard(root, TENANT, family.parent, 'success');

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
    const result = await completeCard(root, TENANT, family.parent, 'failure');
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
    const result = await completeCard(root, TENANT, family.parent, 'success');
    expect(result?.promotedChildren).toHaveLength(family.promotable.size);
    expect((await loadCard(root, 'tenant-b', 'card_other'))?.status).toBe('backlog');
  });
});

/** Runs `fn` and returns the SQL of every statement it prepared, through a wrapper that calls the real prepare. */
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

// Each measured call runs outside the test's request, so it prepares on a fresh connection as one CLI command does.
describe('statements one completion prepares and runs', () => {
  // Writes three families of 1, 10 and 100 cards to a real store.
  it('do not grow with the child count: one read of the children and one update for all it promotes', async () => {
    const runs: { prepared: string[]; run: string[] }[] = [];
    for (const children of [1, 10, 100]) {
      const family = await seedFamily(children);
      // The completion's statements all run inside the call; only its answer waits on the Promise.
      const log = recordStatements(() =>
        recordPrepares(() => outsideRequestStores(() => completeCard(root, TENANT, family.parent, 'success'))),
      );
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
    for (let i = 0; i < 20; i++) parents.push((await createCard(root, TENANT, { title: `parent ${i}` })).id);
    const log = recordStatements(() =>
      recordPrepares(() =>
        outsideRequestStores(() => createCard(root, TENANT, { title: 'child', dependsOn: parents })),
      ),
    );
    expect(countMatching(log.result.prepared, 'INSERT INTO card_deps')).toBe(1);
    expect(countMatching(log.statements, 'INSERT INTO card_deps')).toBe(20);
    const child = await log.result.result;
    expect(child.status).toBe('backlog');
    expect((await cardDetailOf(root, TENANT, child.id))?.deps.parents.sort()).toEqual([...parents].sort());
  });
});
