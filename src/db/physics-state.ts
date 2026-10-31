/**
 * Physics state persistence: particle state (position, velocity, mass, charge, temperature) in SQLite, with BLOB
 * columns for 384-dim vectors.
 */

import { evalNow } from '../core/ablation.js';
import type { DatabaseSyncLike } from './index.js';
import { withWriteScope } from './busy.js';
import type { MemoryEntry } from '../core/memory.js';
import type { PhysicsParticle } from '../core/physics.js';
import { initializeParticle } from '../core/physics.js';
import { placeholders } from '../util/sql.js';
import { bufferToFloat32, float32ToBuffer } from '../util/vector-codec.js';

// Schema migration

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

// Load / Save

interface PhysicsRow {
  memory_id: string;
  position_blob: Buffer;
  velocity_blob: Buffer;
  mass: number;
  charge: number;
  temperature: number;
  last_simulation: string;
}

const PHYSICS_ID_CHUNK = 500;

/**
 * Load physics state for specific memory IDs (or all if no IDs given).
 */
export function loadPhysicsState(
  db: DatabaseSyncLike,
  memoryIds?: string[],
): Map<string, PhysicsParticle> {
  const map = new Map<string, PhysicsParticle>();

  let rows: PhysicsRow[] = [];
  if (memoryIds && memoryIds.length > 0) {
    // Chunked so a whole-store candidate list stays under SQLite's bound-parameter limit.
    for (let i = 0; i < memoryIds.length; i += PHYSICS_ID_CHUNK) {
      const chunk = memoryIds.slice(i, i + PHYSICS_ID_CHUNK);
      const marks = placeholders(chunk.length);
      // SAFETY: the SELECT projects exactly the PhysicsRow columns, in order.
      rows = rows.concat(db.prepare(
        `SELECT memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation
         FROM memory_physics WHERE memory_id IN (${marks})`
      ).all(...chunk) as PhysicsRow[]);
    }
  } else {
    // SAFETY: same PhysicsRow column projection as the branch above, just
    // without the memory_id filter.
    rows = db.prepare(
      `SELECT memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation
       FROM memory_physics`
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

/**
 * Save physics state for multiple particles (batch upsert).
 */
export function savePhysicsState(
  db: DatabaseSyncLike,
  particles: PhysicsParticle[],
): void {
  if (particles.length === 0) return;

  const stmt = db.prepare(`
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
  `);

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

/**
 * Drops every particle, then seeds one per entry that has an embedding; `entries` may be read lazily, as each batch is
 * written before the next is read.
 */
export function resetAllPhysicsState(
  db: DatabaseSyncLike,
  entries: Iterable<MemoryEntry>,
  embeddingIndex: Record<string, number[]>,
  now: Date = evalNow(),
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
    for (const entry of entries) {
      const embedding = embeddingIndex[entry.id];
      if (!embedding || embedding.length === 0) continue;
      if (batch.push(initializeParticle(entry, embedding, now)) === RESET_BATCH) flush();
    }
    flush();
    return count;
  });
}
