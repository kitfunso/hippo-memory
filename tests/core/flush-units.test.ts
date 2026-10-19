// Sleep's queued ops group into units that commit whole, and a flush transaction closes at the first unit boundary past its deadline.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { familyUnits, groupFlush } from '../../src/consolidate/flush-units.js';
import { SLEEP_DB_WAIT_MS, type DatabaseSyncLike } from '../../src/db/index.js';
import type { WriteBudget } from '../../src/util/write-budget.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { commitInChunks, writeEntry } from '../_helpers/root-forms.js';
import type { FlushComponent } from '../../src/store/port/consolidation.js';

// SAFETY: node:sqlite's StatementSync is the class db.ts's prepare returns, and it carries its SQL text.
const { StatementSync } = createRequire(import.meta.url)('node:sqlite') as {
  StatementSync: { prototype: ReturnType<DatabaseSyncLike['prepare']> & { readonly sourceSQL: string } };
};

const ROW_OP = /INSERT INTO memories\(|^DELETE FROM memories WHERE id = \?$/;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const withId = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(`row ${id} text`),
  id,
  ...extra,
});
const idsOf = (c: FlushComponent): string[] =>
  [
    ...new Set([
      ...c.refreshes.map((r) => r.id),
      ...c.writes.map((e) => e.id),
      ...c.deletes,
      ...c.dormant.map((m) => m.entry.id),
    ]),
  ].sort();
const moveOf = (entry: MemoryEntry) => ({
  entry,
  strength: 0.01,
  reason: 'decay' as const,
  dormantAt: '2026-06-01T12:00:00.000Z',
});

describe('groupFlush', () => {
  it('joins every op on a unit into one component and orders components by their first queued op', () => {
    const decayA = withId('A');
    const demotedA = { ...decayA, halfLifeDays: 3 };
    const [R, S, M, B, D] = ['R', 'S', 'M', 'B', 'D'].map((id) => withId(id));

    const ops = {
      refreshes: [{ id: 'E', strength: 0.5 }],
      writes: [decayA, S!, M!, demotedA, B!],
      deletes: [R!.id],
      dormant: [moveOf(D!)],
    };
    const components = groupFlush(ops, [
      [R!.id, S!.id],
      [M!.id, S!.id, decayA.id, B!.id],
      ['E', 'D'],
    ]);

    expect(components.map(idsOf)).toEqual([
      ['D', 'E'],
      ['A', 'B', 'M', 'R', 'S'],
    ]);
    expect(components[1]!.writes.map((e) => e.id)).toEqual(['A', 'S', 'M', 'B']);
    expect(components[1]!.writes[0]).toBe(demotedA);
  });

  it("puts a child in its DAG parent's unit when the run removes the parent", () => {
    const parent = withId('P', { dagLevel: 2 });
    const child = withId('C', { dagParentId: 'P' });
    const other = withId('O', { dagParentId: 'Q' });
    const loadedParent = new Map([
      ['C', 'P'],
      ['O', 'Q'],
      ['K', 'P'],
    ]);
    const ops = {
      refreshes: [{ id: 'K', strength: 0.5 }],
      writes: [other],
      deletes: [child.id],
      dormant: [moveOf(parent)],
    };

    expect(familyUnits(ops, (id) => loadedParent.get(id))).toEqual([
      ['K', 'P'],
      ['C', 'P'],
    ]);
  });
});

describe('commitInChunks', () => {
  it('keeps the largest component whole and closes the transaction at the first boundary past the deadline', async () => {
    const root = makeRoot('flush-units');
    roots.push(root);
    const sources = Array.from({ length: 5 }, (_, i) => createMemory(`source ${i} alpha${i} text`));
    const retired = Array.from({ length: 5 }, (_, i) => createMemory(`retired ${i} beta${i} text`));
    for (const row of [...sources, ...retired]) writeEntry(root, row);
    const semantic = createMemory('merged text of five sources', { layer: Layer.Semantic, source: 'consolidation' });
    const largest: FlushComponent = {
      refreshes: [],
      writes: [semantic, ...sources.map((e) => ({ ...e, halfLifeDays: 3 }))],
      deletes: retired.map((e) => e.id),
      dormant: [],
    };
    const singles = Array.from({ length: 4 }, (_, i): FlushComponent => ({
      refreshes: [],
      writes: [createMemory(`single ${i} gamma${i}`)],
      deletes: [],
      dormant: [],
    }));
    // The flush reads the clock only at BEGIN and at each component boundary, so the test moves it per row op instead.
    let now = 0;
    const clock = () => now;
    const run = StatementSync.prototype.run;
    vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (
      this: typeof StatementSync.prototype,
      ...params: unknown[]
    ) {
      if (ROW_OP.test(this.sourceSQL.trim())) now += 10;
      return run.apply(this, params);
    });

    // A pause is the gap after a commit, so the clock at each one says where that transaction closed.
    const pausedAt: number[] = [];
    const budget: WriteBudget = {
      holdMs: 25,
      clock,
      pause: async (committedAt) => {
        pausedAt.push(committedAt);
      },
    };

    const removed = await commitInChunks(root, [largest, ...singles], {
      snapshot: new Map(),
      budget,
      busyWaitMs: SLEEP_DB_WAIT_MS,
    });

    // The 11 row ops of the largest component, then three singles before the 25 ms hold runs out, then the last.
    expect(pausedAt).toEqual([110, 140]);
    expect(now).toBe(150);
    expect(removed.sort()).toEqual(retired.map((e) => e.id).sort());
  });
});
