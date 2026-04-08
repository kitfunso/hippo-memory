/**
 * Physics state persistence for Hippo.
 * Stores and loads particle state (position, velocity, mass, charge, temperature)
 * in SQLite using BLOB columns for 384-dim vectors.
 */

import type { DatabaseSyncLike } from './db.js';
import type { MemoryEntry } from './memory.js';
import type { PhysicsParticle } from './physics.js';
import { computeMass, computeCharge, computeTemperature, vecZero } from './physics.js';
import { calculateStrength } from './memory.js';

// ---------------------------------------------------------------------------
// Float32Array <-> Buffer serialization
// ---------------------------------------------------------------------------

export function float32ToBuffer(arr: number[]): Buffer {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

export function bufferToFloat32(buf: Buffer | Uint8Array): number[] {
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return [];
  // Ensure we have a properly aligned copy (SQLite may return Uint8Array, not Buffer)
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const aligned = new ArrayBuffer(bytes.length);
  new Uint8Array(aligned).set(bytes);
  return Array.from(new Float32Array(aligned));
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

/**
 * Create the memory_physics table (migration v8).
 * Call this from db.ts MIGRATIONS array.
 */
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

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

interface PhysicsRow {
  memory_id: string;
  position_blob: Buffer;
  velocity_blob: Buffer;
  mass: number;
  charge: number;
  temperature: number;
  last_simulation: string;
}

/**
 * Load physics state for specific memory IDs (or all if no IDs given).
 */
export function loadPhysicsState(
  db: DatabaseSyncLike,
  memoryIds?: string[],
): Map<string, PhysicsParticle> {
  const map = new Map<string, PhysicsParticle>();

  let rows: PhysicsRow[];
  if (memoryIds && memoryIds.length > 0) {
    const placeholders = memoryIds.map(() => '?').join(',');
    rows = db.prepare(
      `SELECT memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation
       FROM memory_physics WHERE memory_id IN (${placeholders})`
    ).all(...memoryIds) as PhysicsRow[];
  } else {
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
    INSERT INTO memory_physics (memory_id, position_blob, velocity_blob, mass, charge, temperature, last_simulation, updated_at)
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

  db.exec('BEGIN');
  try {
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
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Initialize physics state for a memory from its embedding vector.
 * Returns the new particle (does not persist — caller must save).
 */
export function initializeParticle(
  entry: MemoryEntry,
  embedding: number[],
  now: Date = new Date(),
): PhysicsParticle {
  const strength = calculateStrength(entry, now);
  const ageDays = (now.getTime() - new Date(entry.created).getTime()) / (1000 * 60 * 60 * 24);

  return {
    memoryId: entry.id,
    position: [...embedding], // copy — position will diverge from original embedding
    velocity: vecZero(embedding.length),
    mass: computeMass(strength, entry.retrieval_count),
    charge: computeCharge(entry.emotional_valence),
    temperature: computeTemperature(ageDays, 1.0),
    lastSimulation: now.toISOString(),
  };
}

/**
 * Delete physics state for a memory. (Also handled by CASCADE, but explicit for clarity.)
 */
export function deletePhysicsState(db: DatabaseSyncLike, memoryId: string): void {
  db.prepare('DELETE FROM memory_physics WHERE memory_id = ?').run(memoryId);
}

/**
 * Reset all physics states from original embeddings.
 * Drops existing physics data and re-initializes from the embedding index.
 */
export function resetAllPhysicsState(
  db: DatabaseSyncLike,
  entries: MemoryEntry[],
  embeddingIndex: Record<string, number[]>,
  now: Date = new Date(),
): number {
  db.exec('DELETE FROM memory_physics');

  const particles: PhysicsParticle[] = [];
  for (const entry of entries) {
    const embedding = embeddingIndex[entry.id];
    if (!embedding || embedding.length === 0) continue;
    particles.push(initializeParticle(entry, embedding, now));
  }

  if (particles.length > 0) {
    savePhysicsState(db, particles);
  }

  return particles.length;
}

/**
 * Refresh mass, charge, and temperature for existing particles
 * based on current memory attributes (called during consolidation).
 */
export function refreshParticleProperties(
  particles: PhysicsParticle[],
  entries: Map<string, MemoryEntry>,
  now: Date = new Date(),
): void {
  for (const p of particles) {
    const entry = entries.get(p.memoryId);
    if (!entry) continue;

    const strength = calculateStrength(entry, now);
    const ageDays = (now.getTime() - new Date(entry.created).getTime()) / (1000 * 60 * 60 * 24);

    p.mass = computeMass(strength, entry.retrieval_count);
    p.charge = computeCharge(entry.emotional_valence);
    p.temperature = computeTemperature(ageDays, 1.0);
  }
}
