// The sleep physics pass is all-pairs per substep, so past its particle cap it moves only the most recently recalled.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { particlesToSimulate, physicsPass } from '../src/consolidate/physics-pass.js';
import { newConsolidationResult, type SleepRun } from '../src/consolidate/run.js';
import { loadConfig } from '../src/core/config.js';
import { Layer, type MemoryEntry } from '../src/core/memory.js';
import type { PhysicsParticle } from '../src/core/physics.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { loadPhysicsState, savePhysicsState } from '../src/db/physics-state.js';
import { initStore } from '../src/store/open.js';
import { writeEntriesTogether } from '../src/store/entry-writes.js';
import { sqliteSyncStore } from '../src/store/sqlite/store.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

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
  return { memoryId, position: raw.map((v) => v / norm), velocity: [0, 0, 0, 0], mass: 1, charge: 0, temperature: 1, lastSimulation: STALE_SIM };
}

function storedParticles(root: string): Map<string, PhysicsParticle> {
  const db = openHippoDb(root);
  try {
    return loadPhysicsState(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The state consolidate hands the physics pass after decay, with every entry a survivor and nothing pending. */
function sleepRunOver(root: string, entries: MemoryEntry[]): SleepRun {
  const store = sqliteSyncStore(root).localFiles.consolidation;
  return {
    hippoRoot: root, store, now: new Date('2026-01-03T00:00:00.000Z'), dryRun: false, config: loadConfig(root), decayOpts: {},
    result: newConsolidationResult(false), all: entries, retirable: () => false, tombstones: store.tombstoneChecks(false),
    survivors: entries, pendingWrites: [], pendingDeletes: [], pendingDormant: [], units: [],
  };
}

describe('sleep physics cap', () => {
  it('moves only the most recently recalled particles past the cap and leaves the rest as stored', () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-physics-cap-'));
    roots.push(root);
    initStore(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ physics: { enabled: true } }));
    const recent = '2026-01-02T00:00:00.000Z';
    const older = '2026-01-01T00:00:00.000Z';
    const entries: MemoryEntry[] = Array.from({ length: STORED }, (_, i) => ({
      ...createMemory(`fact number ${i} about service ${i * 7919} in region ${i % 13}`, { layer: Layer.Semantic }),
      last_retrieved: i < STORED - CAP ? older : recent,
    }));
    writeEntriesTogether(root, entries);
    const db = openHippoDb(root);
    try {
      savePhysicsState(db, entries.map((e, i) => particle(e.id, i)));
    } finally {
      closeHippoDb(db);
    }
    const seeded = storedParticles(root);
    const leftOut = new Set(entries.slice(0, STORED - CAP).map((e) => e.id));
    const run = sleepRunOver(root, entries);
    try {
      physicsPass(run, CAP);
    } finally {
      run.tombstones.close();
    }

    expect(run.result.physicsSimulated).toBe(CAP);
    expect(run.result.details.some((d) => d.includes(`the ${CAP} most recently recalled of ${STORED}`))).toBe(true);
    const after = storedParticles(root);
    for (const id of leftOut) expect(after.get(id)).toEqual(seeded.get(id));
    const moved = entries.filter((e) => !leftOut.has(e.id)).map((e) => after.get(e.id)?.lastSimulation);
    expect(moved).toHaveLength(CAP);
    expect(moved.every((sim) => sim !== undefined && sim !== STALE_SIM)).toBe(true);
  });

  it('defaults to 1000 particles', () => {
    const stored = Array.from({ length: 1001 }, (_, i) => particle(`m${String(i).padStart(4, '0')}`, i));
    expect(particlesToSimulate(stored, new Map())).toHaveLength(1000);
  });

  it('keeps load order and every particle under the cap, and breaks recall ties by memory id past it', () => {
    const stored = ['c', 'a', 'd', 'b'].map((id, i) => particle(id, i));
    const at = (id: string, lastRetrieved: string) => [id, { ...createMemory(`memory ${id}`), last_retrieved: lastRetrieved }] as const;
    const entries = new Map([at('a', '2026-01-01'), at('b', '2026-01-03'), at('c', '2026-01-01')]);

    expect(particlesToSimulate(stored, entries, 4)).toBe(stored);
    // b is the latest; a and c tie and a wins on id; d has no survivor row, so it is dropped first.
    expect(particlesToSimulate(stored, entries, 2).map((p) => p.memoryId)).toEqual(['a', 'b']);
    expect(particlesToSimulate(stored, entries, 3).map((p) => p.memoryId)).toEqual(['c', 'a', 'b']);
  });
});
