// Sleep's queued ops group into units that commit whole, and a flush transaction closes at the first unit boundary past its deadline.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { familyUnits, groupFlush } from '../src/consolidate/flush-units.js';
import { batchWriteAndDeleteOn, type FlushComponent } from '../src/store/delete-and-batch.js';
import { initStore, openStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

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

const withId = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({ ...createMemory(`row ${id} text`), id, ...extra });
const idsOf = (c: FlushComponent): string[] =>
  [...new Set([...c.writes.map((e) => e.id), ...c.deletes, ...c.dormant.map((m) => m.entry.id)])].sort();
const moveOf = (entry: MemoryEntry) => ({ entry, strength: 0.01, reason: 'decay' as const, dormantAt: '2026-06-01T12:00:00.000Z' });

describe('groupFlush', () => {
  it('joins every op on a unit into one component and orders components by their first queued op', () => {
    const decayA = withId('A');
    const demotedA = { ...decayA, half_life_days: 3 };
    const [R, S, M, B, D] = ['R', 'S', 'M', 'B', 'D'].map((id) => withId(id));

    const components = groupFlush([decayA, S!, M!, demotedA, B!], [R!.id], [moveOf(D!)], [[R!.id, S!.id], [M!.id, S!.id, decayA.id, B!.id]]);

    expect(components.map(idsOf)).toEqual([['A', 'B', 'M', 'R', 'S'], ['D']]);
    expect(components[0]!.writes.map((e) => e.id)).toEqual(['A', 'S', 'M', 'B']);
    expect(components[0]!.writes[0]).toBe(demotedA);
  });

  it('puts a child in its DAG parent\'s unit when the run removes the parent', () => {
    const parent = withId('P', { dag_level: 2 });
    const child = withId('C', { dag_parent_id: 'P' });
    const other = withId('O', { dag_parent_id: 'Q' });
    const snapshot = new Map([child, other, parent].map((e) => [e.id, e]));

    expect(familyUnits([other], [child.id], [moveOf(parent)], snapshot)).toEqual([['C', 'P']]);
  });
});

describe('batchWriteAndDeleteOn', () => {
  it('keeps the largest component whole and closes the transaction at the first boundary past the deadline', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-flush-units-'));
    roots.push(root);
    initStore(root);
    const sources = Array.from({ length: 5 }, (_, i) => createMemory(`source ${i} alpha${i} text`));
    const retired = Array.from({ length: 5 }, (_, i) => createMemory(`retired ${i} beta${i} text`));
    for (const row of [...sources, ...retired]) writeEntry(root, row);
    const semantic = createMemory('merged text of five sources', { layer: Layer.Semantic, source: 'consolidation' });
    const largest: FlushComponent = {
      writes: [semantic, ...sources.map((e) => ({ ...e, half_life_days: 3 }))],
      deletes: retired.map((e) => e.id),
      dormant: [],
    };
    const singles = Array.from({ length: 4 }, (_, i): FlushComponent => ({ writes: [createMemory(`single ${i} gamma${i}`)], deletes: [], dormant: [] }));
    // The flush reads the clock only at BEGIN and at each component boundary, so the test moves it per row op instead.
    let now = 0;
    const clock = () => now;
    const run = StatementSync.prototype.run;
    vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (this: typeof StatementSync.prototype, ...params: unknown[]) {
      if (ROW_OP.test(this.sourceSQL.trim())) now += 10;
      return run.apply(this, params);
    });

    const db = openStore(root);
    try {
      const first = batchWriteAndDeleteOn(db, root, [largest, ...singles], 0, { holdMs: 25, clock });
      expect(now).toBe(110);
      expect(first.next).toBe(1);
      expect(first.removedIds.sort()).toEqual(retired.map((e) => e.id).sort());

      const second = batchWriteAndDeleteOn(db, root, [largest, ...singles], 1, { holdMs: 25, clock });
      expect(second.next).toBe(4);
    } finally {
      closeHippoDb(db);
    }
  });
});
