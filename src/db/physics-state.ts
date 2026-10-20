/**
 * Physics state persistence: particle state (position, velocity, mass, charge, temperature) in SQLite, with BLOB
 * columns for 384-dim vectors.
 */

import { evalNow } from '../base/memory/ablation.js';
import type { DatabaseSyncLike } from './index.js';
import { withWriteScope } from './busy.js';
import { strengthOptionsOf, type MemoryEntry, type StrengthOptions } from '../base/memory/memory.js';
import type { PhysicsParticle } from '../base/rank/physics.js';
import { initializeParticle, vecNorm } from '../base/rank/physics.js';
import { chunked } from '../base/util/chunked.js';
import { bufferToFloat32, float32ToBuffer } from '../base/util/vector-codec.js';
import { cachedStatement } from './statement-cache.js';

/** Create the memory_physics table (migration v8). */
export function createPhysicsTable(db: DatabaseSyncLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_physics (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      position_blob BLOB NOT NULL,
      velocity_blob BLOB NOT NULL,
      mass REAL NOT NULL,
      charge REAL NOT NULL,
      temperature REAL NOT NULL,
      last_simulation TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_physics_mass
    ON memory_physics(mass DESC);
  `);
}

// SAFETY: every read cast to this row selects PHYSICS_COLUMNS; scripts/check-row-casts.mjs proves it.
interface PhysicsRow {
  memory_id: string;
  position_blob: Uint8Array;
  velocity_blob: Uint8Array;
  mass: number;
  charge: number;
  temperature: number;
  last_simulation: string;
}
const PHYSICS_COLUMNS = 'memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation';

/**
 * Load physics state for specific memory IDs (or all if no IDs given).
 */
export function loadPhysicsState(db: DatabaseSyncLike, memoryIds?: string[]): Map<string, PhysicsParticle> {
  const map = new Map<string, PhysicsParticle>();

  let rows: PhysicsRow[] = [];
  if (memoryIds && memoryIds.length > 0) {
    // Chunked so a whole-store candidate list stays under SQLite's bound-parameter limit.
    for (const chunk of chunked(memoryIds)) {
      rows.push(
        ...(cachedStatement(
          db,
          `SELECT ${PHYSICS_COLUMNS}
         FROM memory_physics WHERE memory_id IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(chunk)) as PhysicsRow[]),
      );
    }
  } else {
    rows = cachedStatement(
      db,
      `SELECT ${PHYSICS_COLUMNS}
       FROM memory_physics`,
    ).all() as PhysicsRow[];
  }

  for (const row of rows) {
    map.set(row.memory_id, {
      memoryId: row.memory_id,
      position: bufferToFloat32(row.position_blob),
      velocity: bufferToFloat32(row.velocity_blob),
      mass: row.mass,
      charge: row.charge,
      temperature: row.temperature,
      lastSimulation: row.last_simulation,
    });
  }

  return map;
}

/** How many particles are stored and the sum of their speeds, in loadPhysicsState's order, reading one column. */
export function physicsSpeedSum(db: DatabaseSyncLike) {
  let count = 0;
  let speedSum = 0;
  // SAFETY: the SELECT names exactly this one column.
  const rows = db.prepare('SELECT velocity_blob FROM memory_physics ORDER BY rowid').iterate() as Iterable<{
    velocity_blob: Uint8Array;
  }>;
  for (const row of rows) {
    count++;
    speedSum += vecNorm(bufferToFloat32(row.velocity_blob));
  }
  return { count, speedSum };
}

/**
 * Save physics state for multiple particles (batch upsert).
 */
export function savePhysicsState(db: DatabaseSyncLike, particles: PhysicsParticle[]): void {
  if (particles.length === 0) return;

  const stmt = cachedStatement(
    db,
    `
    INSERT INTO memory_physics (
      memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(memory_id) DO UPDATE SET
      position_blob = excluded.position_blob,
      velocity_blob = excluded.velocity_blob,
      mass = excluded.mass,
      charge = excluded.charge,
      temperature = excluded.temperature,
      last_simulation = excluded.last_simulation,
      updated_at = datetime('now')
  `,
  );

  withWriteScope(db, 'save_particles', () => {
    for (const p of particles) {
      stmt.run(
        p.memoryId,
        float32ToBuffer(p.position),
        float32ToBuffer(p.velocity),
        p.mass,
        p.charge,
        p.temperature,
        p.lastSimulation,
      );
    }
  });
}

const RESET_BATCH = 64;

/** resetPhysicsFromSeeds for each of `entries` that has a vector in `embeddingIndex`. */
export function resetAllPhysicsState(
  db: DatabaseSyncLike,
  entries: Iterable<MemoryEntry>,
  embeddingIndex: Record<string, number[]>,
  now: Date = evalNow(),
  rules: StrengthOptions = strengthOptionsOf(undefined),
): number {
  return resetPhysicsFromSeeds(db, seedsOf(entries, embeddingIndex), rules, now);
}

function* seedsOf(entries: Iterable<MemoryEntry>, embeddingIndex: Record<string, number[]>): Generator<ParticleSeed> {
  for (const entry of entries) {
    const embedding = embeddingIndex[entry.id];
    if (embedding && embedding.length > 0) yield [entry, embedding];
  }
}

/** A memory and the vector its fresh particle starts at. */
export type ParticleSeed = readonly [MemoryEntry, number[]];

/** Drops every particle, then seeds one per pair in `seeds`, which may be read lazily, a batch at a time. */
export function resetPhysicsFromSeeds(
  db: DatabaseSyncLike,
  seeds: Iterable<ParticleSeed>,
  rules: StrengthOptions,
  now = evalNow(),
): number {
  db.exec('DELETE FROM memory_physics');

  // One transaction for every batch, so a failure part way leaves no particles rather than some.
  return withWriteScope(db, 'reset_particles', () => {
    let count = 0;
    let batch: PhysicsParticle[] = [];
    const flush = (): void => {
      savePhysicsState(db, batch);
      count += batch.length;
      batch = [];
    };
    for (const [entry, embedding] of seeds) {
      if (embedding.length === 0) continue;
      if (batch.push(initializeParticle(entry, embedding, rules, now)) === RESET_BATCH) flush();
    }
    flush();
    return count;
  });
}
