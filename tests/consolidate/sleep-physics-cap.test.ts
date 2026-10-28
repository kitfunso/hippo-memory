// The sleep physics pass is all-pairs per substep, so past its particle cap it moves only the most recently recalled.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { particlesToSimulate, physicsPass } from '../../src/domain/consolidate/physics-pass.js';
import { newConsolidationResult, type SleepRun } from '../../src/domain/consolidate/run.js';
import { SleepRows, Survivors } from '../../src/domain/consolidate/survivors.js';
import { loadConfig } from '../../src/host/config-file.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import type { PhysicsParticle } from '../../src/base/rank/physics.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { loadAllPhysicsState, savePhysicsState } from '../../src/db/physics-state.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { tombstoneChecks } from '../../src/domain/consolidate/tombstones.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { READ_PAGE_ROWS } from '../../src/base/util/pages.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { detailLines } from '../_helpers/sleep-lines.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/rows.js';
import type { RecallCursor } from '../../src/base/ports/store/consolidation.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const STALE_SIM = '2000-01-01T00:00:00.000Z';
const CAP = 20;
const STORED = 25;

function particle(memoryId: string, i: number): PhysicsParticle {
  const raw = [Math.cos(i), Math.sin(i), Math.cos(i * 0.7), Math.sin(i * 1.3)];
  const norm = Math.hypot(...raw);
  return {
    memoryId,
    position: raw.map((v) => v / norm),
    velocity: [0, 0, 0, 0],
    mass: 1,
    charge: 0,
    temperature: 1,
    lastSimulation: STALE_SIM,
  };
}

function storedParticles(root: string): Map<string, PhysicsParticle> {
  const db = openHippoDb(root);
  try {
    return loadAllPhysicsState(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The state consolidate hands the physics pass after decay, with every entry a survivor and nothing pending. */
function sleepRunOver(root: string, entries: MemoryEntry[]): SleepRun {
  const store = sqliteStore(root);
  const rows = new SleepRows(store, new Map(), READ_PAGE_ROWS);
  const survivors = new Survivors(rows);
  for (const e of entries) survivors.keep(e.id, e.strength);
  return {
    strength: PRODUCTION_STRENGTH,
    tenantId: 'default',
    store,
    now: new Date('2026-01-03T00:00:00.000Z'),
    dryRun: false,
    config: loadConfig(root),
    decayOpts: {},
    result: newConsolidationResult(false),
    rows,
    retirable: () => false,
    tombstones: tombstoneChecks(store, false),
    survivors,
    pendingRefreshes: [],
    pendingWrites: [],
    pendingDeletes: [],
    pendingDormant: [],
    parentOf: new Map(),
    units: [],
  };
}

describe('sleep physics cap', () => {
  it('moves only the most recently recalled particles past the cap and leaves the rest as stored', async () => {
    const root = makeRoot('physics-cap');
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ physics: { enabled: true } }));
    const recent = '2026-01-02T00:00:00.000Z';
    const older = '2026-01-01T00:00:00.000Z';
    const entries: MemoryEntry[] = Array.from({ length: STORED }, (_, i) => ({
      ...createMemory(`fact number ${i} about service ${i * 7919} in region ${i % 13}`, { layer: Layer.Semantic }),
      lastRetrieved: i < STORED - CAP ? older : recent,
    }));
    writeEntriesTogether(root, entries);
    const db = openHippoDb(root);
    try {
      savePhysicsState(
        db,
        entries.map((e, i) => particle(e.id, i)),
      );
    } finally {
      closeHippoDb(db);
    }
    const seeded = storedParticles(root);
    const leftOut = new Set(entries.slice(0, STORED - CAP).map((e) => e.id));
    const run = sleepRunOver(root, entries);
    await physicsPass(run, CAP);

    expect(run.result.physicsSimulated).toBe(CAP);
    expect(detailLines(run.result).some((d) => d.includes(`the ${CAP} most recently recalled of ${STORED}`))).toBe(
      true,
    );
    const after = storedParticles(root);
    for (const id of leftOut) expect(after.get(id)).toEqual(seeded.get(id));
    const moved = entries.filter((e) => !leftOut.has(e.id)).map((e) => after.get(e.id)?.lastSimulation);
    expect(moved).toHaveLength(CAP);
    expect(moved.every((sim) => sim !== undefined && sim !== STALE_SIM)).toBe(true);
  });

  it("ranks a particle this run rehearsed by the run's recall time, which the store does not hold yet", async () => {
    const root = makeRoot('physics-cap-rehearsed');
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ physics: { enabled: true } }));
    const entries: MemoryEntry[] = Array.from({ length: STORED }, (_, i) => ({
      ...createMemory(`fact number ${i} about service ${i * 7919} in region ${i % 13}`, { layer: Layer.Semantic }),
      lastRetrieved: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
    }));
    writeEntriesTogether(root, entries);
    const db = openHippoDb(root);
    try {
      savePhysicsState(
        db,
        entries.map((e, i) => particle(e.id, i)),
      );
    } finally {
      closeHippoDb(db);
    }
    const run = sleepRunOver(root, entries);
    // The oldest on disk, recalled in this run as replay does: the store sees the new time only at the flush.
    const rehearsed = { ...entries[0]!, lastRetrieved: run.now.toISOString() };
    await run.survivors.set([rehearsed]);
    await physicsPass(run, CAP);

    const after = storedParticles(root);
    expect(after.get(rehearsed.id)?.lastSimulation).not.toBe(STALE_SIM);
    // The cap still holds: the least recently recalled of the rest gives up its place.
    expect(after.get(entries[STORED - CAP]!.id)?.lastSimulation).toBe(STALE_SIM);
    expect(run.result.physicsSimulated).toBe(CAP);
  });

  it('defaults to 1000 particles', () => {
    const stored = Array.from({ length: 1001 }, (_, i) => `m${String(i).padStart(4, '0')}`);
    expect(particlesToSimulate(stored, [])).toHaveLength(1000);
  });

  it('keeps load order and every particle under the cap, and fills past it from the unranked by memory id', () => {
    const stored = ['c', 'a', 'd', 'b'];
    // Ranked by the caller, most recently recalled first.
    const recalled = ['b', 'a', 'c'];

    expect(particlesToSimulate(stored, recalled, 4)).toBe(stored);
    expect(particlesToSimulate(stored, recalled, 2)).toEqual(['a', 'b']);
    expect(particlesToSimulate(stored, recalled, 3)).toEqual(['c', 'a', 'b']);
    expect(particlesToSimulate(stored, ['b'], 3)).toEqual(['c', 'a', 'b']);
  });
});

describe('sleep physics cap reads', () => {
  const FULL_ROW = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories`;

  interface SeededRun {
    run: SleepRun;
    root: string;
  }

  function seededRun(stored: number): SeededRun {
    const root = makeRoot('physics-cap-reads');
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ physics: { enabled: true } }));
    const entries: MemoryEntry[] = Array.from({ length: stored }, (_, i) => ({
      ...createMemory(`fact number ${i} about service ${i * 7919} in region ${i % 13}`, { layer: Layer.Semantic }),
      lastRetrieved: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
    }));
    writeEntriesTogether(root, entries);
    const db = openHippoDb(root);
    try {
      savePhysicsState(
        db,
        entries.map((e, i) => particle(e.id, i)),
      );
    } finally {
      closeHippoDb(db);
    }
    return { run: sleepRunOver(root, entries), root };
  }

  it('reads the rows of the particles it moves and no other, however many are stored', async () => {
    const read = async (stored: number) => {
      const { run } = seededRun(stored);
      const log = await recordStatementsAsync(() => physicsPass(run, CAP));
      expect(run.result.physicsSimulated).toBe(CAP);
      return log.reads.filter(({ sql }) => sql.startsWith(FULL_ROW)).reduce((sum, r) => sum + r.rows, 0);
    };
    const few = await read(40);
    const many = await read(120);
    expect(few).toBe(CAP);
    expect(many).toBe(few);
  });

  it('pages the whole recall order off idx_memories_last_retrieved, with no sort of its own', async () => {
    const { run, root } = seededRun(30);
    const consolidation = run.store.consolidation;
    const { statements } = await recordStatementsAsync(async () => {
      const first = await consolidation.particlesByRecall({ limit: 5 });
      if (first.next) await consolidation.particlesByRecall({ limit: 5, after: first.next });
    });
    const [firstSql, seekSql] = statements.filter((s) => s.includes('memory_physics'));
    if (firstSql === undefined || seekSql === undefined) {
      throw new Error('particlesByRecall prepared no first and seek statement over memory_physics');
    }
    const db = openHippoDb(root);
    try {
      // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
      const plan = (sql: string, ...params: Array<string | number>) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
          .map((r) => r.detail)
          .join(' | ');
      for (const p of [
        plan(firstSql, 6),
        plan(seekSql, '2026-01-01T00:10:00.000Z', '2026-01-01T00:10:00.000Z', 9, 6),
      ]) {
        expect(p).toContain('USING INDEX idx_memories_last_retrieved');
        expect(p).not.toContain('TEMP B-TREE');
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('reads each page of a recall time many particles share in a flat number of rows, each particle once', async () => {
    const { run, root } = seededRun(0);
    const tied: MemoryEntry[] = Array.from({ length: 60 }, (_, i) => ({
      ...createMemory(`tied fact ${i} about host ${i * 31}`, { layer: Layer.Semantic }),
      lastRetrieved: '2026-01-01T00:00:00.000Z',
    }));
    writeEntriesTogether(root, tied);
    const db = openHippoDb(root);
    try {
      savePhysicsState(
        db,
        tied.map((e, i) => particle(e.id, i)),
      );
    } finally {
      closeHippoDb(db);
    }
    const PAGE = 7;
    const seen: string[] = [];
    const { reads } = await recordStatementsAsync(async () => {
      let after: RecallCursor | undefined;
      do {
        const page = await run.store.consolidation.particlesByRecall({ limit: PAGE, after });
        seen.push(...page.memories.map((m) => m.id));
        after = page.next ?? undefined;
      } while (after);
    });
    const pages = reads.filter((r) => r.sql.includes('memory_physics'));
    expect(pages).toHaveLength(Math.ceil(tied.length / PAGE));
    for (const p of pages) expect(p.rows).toBeLessThanOrEqual(PAGE + 1);
    expect(new Set(seen).size).toBe(tied.length);
    expect(seen).toHaveLength(tied.length);
  });
});
