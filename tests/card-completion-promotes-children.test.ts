// Completing a card promotes exactly its backlog children whose parents are all done, in card_deps order, and touches no other child.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '../src/core/card.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { claimCard, completeCard, createCard, loadCard, loadCardDeps, reviewCard, transitionCard } from '../src/store/cards.js';
import { initStore } from '../src/store/open.js';
import { countMatching, recordStatements } from './_helpers/count-statements.js';

const TENANT = 'default';
interface Preparer { prepare(sql: string): object }
// SAFETY: node:sqlite has no bundled types; prepare takes SQL text and returns a statement object.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: { prototype: Preparer } };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-card-promotion-'));
  initStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function toReview(id: string): void {
  claimCard(root, TENANT, id, 'test-runtime');
  reviewCard(root, TENANT, id);
}

function finish(id: string): void {
  toReview(id);
  completeCard(root, TENANT, id, 'success');
}

function card(id: string): Card {
  const found = loadCard(root, TENANT, id);
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
function seedFamily(children: number): Family {
  const parent = createCard(root, TENANT, { title: 'parent' }).id;
  const doneParent = createCard(root, TENANT, { title: 'done parent' }).id;
  const openParent = createCard(root, TENANT, { title: 'open parent' }).id;
  const promotable = new Set<string>();
  const otherIds: string[] = [];
  const ids = Array.from({ length: children }, (_, i) => {
    const second = i % 4 === 3 ? [openParent] : i % 3 === 1 ? [doneParent] : [];
    return createCard(root, TENANT, { title: `child ${i}`, dependsOn: [parent, ...second] }).id;
  });
  finish(doneParent);
  const db = openHippoDb(root);
  try {
    ids.forEach((id, i) => {
      if (i % 5 === 4) transitionCard(db, TENANT, id, { from: ['backlog'], to: 'ready' });
      if (i % 4 === 3 || i % 5 === 4) otherIds.push(id);
      else promotable.add(id);
    });
  } finally {
    closeHippoDb(db);
  }
  toReview(parent);
  return { parent, promotable, others: otherIds.map(card) };
}

describe('completeCard child promotion', () => {
  it.each([1, 10, 100])('promotes the unblocked backlog children of a parent with %i children, in card_deps order', (children) => {
    const family = seedFamily(children);
    const result = completeCard(root, TENANT, family.parent, 'success');

    const inDepsOrder = loadCardDeps(root, TENANT, family.parent).children.filter((id) => family.promotable.has(id));
    expect(result?.promotedChildren).toEqual(inDepsOrder);
    expect(result?.promotedChildren).toHaveLength(family.promotable.size);
    expect(result?.card.status).toBe('done');
    for (const id of family.promotable) {
      expect(card(id)).toMatchObject({ status: 'ready', leaseUntil: null, heartbeatAt: null, assigneeRuntime: null });
    }
    expect(family.others.map((before) => card(before.id))).toEqual(family.others);
  }, 60_000);

  it('promotes nothing when the parent is shelved', () => {
    const family = seedFamily(10);
    const result = completeCard(root, TENANT, family.parent, 'failure');
    expect(result?.promotedChildren).toEqual([]);
    expect([...family.promotable].map((id) => card(id).status)).toEqual([...family.promotable].map(() => 'backlog'));
  }, 60_000);

  it("leaves another tenant's child of the same parent id in backlog", () => {
    const family = seedFamily(3);
    const db = openHippoDb(root);
    try {
      db.prepare(`
        INSERT INTO cards (id, title, status, created_at, updated_at, tenant_id) VALUES ('card_other', 'other', 'backlog', 'x', 'x', 'tenant-b')
      `).run();
      db.prepare(`INSERT INTO card_deps (parent, child, tenant_id, created_at) VALUES (?, 'card_other', 'tenant-b', 'x')`).run(family.parent);
    } finally {
      closeHippoDb(db);
    }
    const result = completeCard(root, TENANT, family.parent, 'success');
    expect(result?.promotedChildren).toHaveLength(family.promotable.size);
    expect(loadCard(root, 'tenant-b', 'card_other')?.status).toBe('backlog');
  }, 60_000);
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

describe('statements one completion prepares and runs', () => {
  it('do not grow with the child count: one read of the children and one update for all it promotes', () => {
    const runs = [1, 10, 100].map((children) => {
      const family = seedFamily(children);
      const log = recordStatements(() => recordPrepares(() => completeCard(root, TENANT, family.parent, 'success')));
      expect(log.result.result?.promotedChildren).toHaveLength(family.promotable.size);
      return { prepared: log.result.prepared, run: log.statements };
    });
    expect(runs.map((r) => [r.prepared.length, r.run.length])).toEqual(runs.map(() => [runs[0].prepared.length, runs[0].run.length]));
    for (const { prepared, run } of runs) {
      expect(countMatching(prepared, 'FROM card_deps')).toBe(1);
      expect(countMatching(run, 'FROM card_deps')).toBe(1);
      expect(countMatching(run, 'UPDATE cards SET status')).toBe(2);
    }
  }, 60_000);

  it('prepares the dependency insert of a new card once for 20 parents', () => {
    const parents = Array.from({ length: 20 }, (_, i) => createCard(root, TENANT, { title: `parent ${i}` }).id);
    const log = recordStatements(() => recordPrepares(() => createCard(root, TENANT, { title: 'child', dependsOn: parents })));
    expect(countMatching(log.result.prepared, 'INSERT INTO card_deps')).toBe(1);
    expect(countMatching(log.statements, 'INSERT INTO card_deps')).toBe(20);
    expect(log.result.result.status).toBe('backlog');
    expect(loadCardDeps(root, TENANT, log.result.result.id).parents.sort()).toEqual([...parents].sort());
  });
});
