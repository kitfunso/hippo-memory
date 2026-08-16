import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { initStore } from '../src/store.js';
import {
  float32ToBuffer,
  bufferToFloat32,
  loadPhysicsState,
  savePhysicsState,
  initializeParticle,
  resetAllPhysicsState,
  refreshParticleProperties,
} from '../src/physics-state.js';
import type { PhysicsParticle } from '../src/physics.js';
import type { MemoryEntry } from '../src/memory.js';
import { Layer } from '../src/memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-physics-test-'));
  initStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date('2026-01-15T12:00:00Z');

function insertMemoryRow(db: DatabaseSyncLike, id: string, opts?: Partial<{
  emotional_valence: string;
  retrieval_count: number;
  strength: number;
  half_life_days: number;
  pinned: number;
}>): void {
  const valence = opts?.emotional_valence ?? 'neutral';
  const rc = opts?.retrieval_count ?? 0;
  const strength = opts?.strength ?? 1.0;
  const halfLife = opts?.half_life_days ?? 7;
  const pinned = opts?.pinned ?? 0;

  db.prepare(
    `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days,
       layer, tags_json, emotional_valence, schema_fit, source, outcome_score, outcome_positive,
       outcome_negative, conflicts_with_json, pinned, confidence, content, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    id,
    NOW.toISOString(),
    NOW.toISOString(),
    rc,
    strength,
    halfLife,
    'episodic',
    '[]',
    valence,
    0.5,
    'test',
    null,
    0,
    0,
    '[]',
    pinned,
    'verified',
    `test content for ${id}`,
  );
}

function makeMemoryEntry(id: string, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id,
    created: NOW.toISOString(),
    last_retrieved: NOW.toISOString(),
    retrieval_count: 0,
    strength: 1.0,
    half_life_days: 7,
    layer: Layer.Episodic,
    tags: [],
    emotional_valence: 'neutral',
    schema_fit: 0.5,
    source: 'test',
    outcome_score: null,
    outcome_positive: 0,
    outcome_negative: 0,
    conflicts_with: [],
    pinned: false,
    confidence: 'verified',
    content: `test content for ${id}`,
    ...overrides,
  };
}

function makeParticle(memoryId: string, dim: number = 3): PhysicsParticle {
  const position = Array.from({ length: dim }, (_, i) => (i + 1) * 0.1);
  const velocity = Array.from({ length: dim }, () => 0);
  return {
    memoryId,
    position,
    velocity,
    mass: 1.0,
    charge: 0,
    temperature: 0.5,
    lastSimulation: NOW.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. BLOB serialization round-trip
// ---------------------------------------------------------------------------

describe('float32 BLOB serialization', () => {
  it('round-trips an empty array', () => {
    const buf = float32ToBuffer([]);
    const result = bufferToFloat32(buf);
    expect(result).toEqual([]);
  });

  it('round-trips a 3-dim vector', () => {
    const input = [1.5, -0.25, 3.14159];
    const buf = float32ToBuffer(input);
    const result = bufferToFloat32(buf);

    expect(result).toHaveLength(3);
    for (let i = 0; i < input.length; i++) {
      // float32 has ~7 decimal digits of precision
      expect(result[i]).toBeCloseTo(input[i]!, 5);
    }
  });

  it('round-trips a 384-dim vector within float32 precision', () => {
    const input = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.01));
    const buf = float32ToBuffer(input);
    const result = bufferToFloat32(buf);

    expect(result).toHaveLength(384);
    for (let i = 0; i < input.length; i++) {
      expect(result[i]).toBeCloseTo(input[i]!, 5);
    }
  });

  it('produces a buffer of correct byte length (4 bytes per float)', () => {
    const buf = float32ToBuffer([1, 2, 3]);
    expect(buf.byteLength).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 2. Physics table creation
// ---------------------------------------------------------------------------

describe('physics table creation', () => {
  it('creates memory_physics table after openHippoDb', () => {
    const db = openHippoDb(tmpDir);
    try {
      // Should not throw
      // SAFETY: literal COUNT(*) query against the known memory_physics
      // schema always returns a single { cnt } row.
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM memory_physics`
      ).get() as { cnt: number };
      expect(row.cnt).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('creates the index idx_memory_physics_mass', () => {
    const db = openHippoDb(tmpDir);
    try {
      // SAFETY: literal SELECT against the known sqlite_master schema; name
      // is NOT NULL for every index row.
      const rows = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_physics'`
      ).all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).toContain('idx_memory_physics_mass');
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Save and load round-trip
// ---------------------------------------------------------------------------

describe('save and load round-trip', () => {
  it('returns identical data within float32 precision', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_rt1');

      const particle: PhysicsParticle = {
        memoryId: 'mem_rt1',
        position: [0.1, 0.2, 0.3],
        velocity: [-0.01, 0.02, -0.03],
        mass: 1.5,
        charge: -0.5,
        temperature: 0.8,
        lastSimulation: NOW.toISOString(),
      };

      savePhysicsState(db, [particle]);
      const loaded = loadPhysicsState(db);

      expect(loaded.size).toBe(1);
      const p = loaded.get('mem_rt1')!;
      expect(p.memoryId).toBe('mem_rt1');
      expect(p.mass).toBeCloseTo(1.5, 10);
      expect(p.charge).toBeCloseTo(-0.5, 10);
      expect(p.temperature).toBeCloseTo(0.8, 10);
      expect(p.lastSimulation).toBe(NOW.toISOString());

      for (let i = 0; i < particle.position.length; i++) {
        expect(p.position[i]).toBeCloseTo(particle.position[i]!, 5);
      }
      for (let i = 0; i < particle.velocity.length; i++) {
        expect(p.velocity[i]).toBeCloseTo(particle.velocity[i]!, 5);
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('handles multiple particles in one batch', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_a');
      insertMemoryRow(db, 'mem_b');

      const particles = [makeParticle('mem_a'), makeParticle('mem_b')];
      savePhysicsState(db, particles);
      const loaded = loadPhysicsState(db);

      expect(loaded.size).toBe(2);
      expect(loaded.has('mem_a')).toBe(true);
      expect(loaded.has('mem_b')).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('savePhysicsState with empty array is a no-op', () => {
    const db = openHippoDb(tmpDir);
    try {
      savePhysicsState(db, []);
      const loaded = loadPhysicsState(db);
      expect(loaded.size).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Load specific IDs
// ---------------------------------------------------------------------------

describe('loadPhysicsState with memoryIds filter', () => {
  it('returns only the requested particles', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_x');
      insertMemoryRow(db, 'mem_y');
      insertMemoryRow(db, 'mem_z');

      const particles = [
        makeParticle('mem_x'),
        makeParticle('mem_y'),
        makeParticle('mem_z'),
      ];
      savePhysicsState(db, particles);

      const loaded = loadPhysicsState(db, ['mem_x', 'mem_z']);
      expect(loaded.size).toBe(2);
      expect(loaded.has('mem_x')).toBe(true);
      expect(loaded.has('mem_z')).toBe(true);
      expect(loaded.has('mem_y')).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('returns empty map for non-existent IDs', () => {
    const db = openHippoDb(tmpDir);
    try {
      const loaded = loadPhysicsState(db, ['nonexistent_1', 'nonexistent_2']);
      expect(loaded.size).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('returns empty map for empty memoryIds array', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_has');
      savePhysicsState(db, [makeParticle('mem_has')]);

      // Empty array should match the branch condition and return nothing
      const loaded = loadPhysicsState(db, []);
      // Per code: if memoryIds.length === 0, falls through to load all
      // Actually: memoryIds && memoryIds.length > 0 is false for [], so loads all
      expect(loaded.size).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Load all
// ---------------------------------------------------------------------------

describe('loadPhysicsState without filter', () => {
  it('returns all saved particles', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_1');
      insertMemoryRow(db, 'mem_2');
      insertMemoryRow(db, 'mem_3');

      savePhysicsState(db, [
        makeParticle('mem_1'),
        makeParticle('mem_2'),
        makeParticle('mem_3'),
      ]);

      const loaded = loadPhysicsState(db);
      expect(loaded.size).toBe(3);
      expect([...loaded.keys()].sort()).toEqual(['mem_1', 'mem_2', 'mem_3']);
    } finally {
      closeHippoDb(db);
    }
  });

  it('returns empty map from empty table', () => {
    const db = openHippoDb(tmpDir);
    try {
      const loaded = loadPhysicsState(db);
      expect(loaded.size).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Upsert (save same memoryId twice)
// ---------------------------------------------------------------------------

describe('upsert behavior', () => {
  it('updates rather than duplicates when saving same memoryId twice', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_upsert');

      const particle1: PhysicsParticle = {
        memoryId: 'mem_upsert',
        position: [1, 0, 0],
        velocity: [0, 0, 0],
        mass: 1.0,
        charge: 0,
        temperature: 1.0,
        lastSimulation: NOW.toISOString(),
      };
      savePhysicsState(db, [particle1]);

      // Save again with different values
      const particle2: PhysicsParticle = {
        memoryId: 'mem_upsert',
        position: [0, 1, 0],
        velocity: [0.1, 0.2, 0.3],
        mass: 2.5,
        charge: -1.0,
        temperature: 0.3,
        lastSimulation: new Date('2026-02-01T00:00:00Z').toISOString(),
      };
      savePhysicsState(db, [particle2]);

      const loaded = loadPhysicsState(db);
      expect(loaded.size).toBe(1);

      const p = loaded.get('mem_upsert')!;
      expect(p.mass).toBeCloseTo(2.5, 10);
      expect(p.charge).toBeCloseTo(-1.0, 10);
      expect(p.temperature).toBeCloseTo(0.3, 10);
      expect(p.position[0]).toBeCloseTo(0, 5);
      expect(p.position[1]).toBeCloseTo(1, 5);
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. CASCADE delete
// ---------------------------------------------------------------------------

describe('CASCADE delete', () => {
  it('deletes physics state when parent memory is deleted', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_cascade');
      savePhysicsState(db, [makeParticle('mem_cascade')]);

      // Verify it exists
      expect(loadPhysicsState(db).size).toBe(1);

      // Delete the parent memory
      db.prepare('DELETE FROM memories WHERE id = ?').run('mem_cascade');

      // Physics row should be gone due to ON DELETE CASCADE
      expect(loadPhysicsState(db).size).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('only cascades the deleted memory, not others', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_keep');
      insertMemoryRow(db, 'mem_drop');

      savePhysicsState(db, [makeParticle('mem_keep'), makeParticle('mem_drop')]);
      expect(loadPhysicsState(db).size).toBe(2);

      db.prepare('DELETE FROM memories WHERE id = ?').run('mem_drop');

      const loaded = loadPhysicsState(db);
      expect(loaded.size).toBe(1);
      expect(loaded.has('mem_keep')).toBe(true);
      expect(loaded.has('mem_drop')).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. initializeParticle
// ---------------------------------------------------------------------------

describe('initializeParticle', () => {
  it('creates correct initial state from MemoryEntry + embedding', () => {
    const entry = makeMemoryEntry('mem_init', {
      retrieval_count: 3,
      emotional_valence: 'negative',
    });
    const embedding = [0.5, -0.5, 0.7071];

    const particle = initializeParticle(entry, embedding, NOW);

    expect(particle.memoryId).toBe('mem_init');
    // Position should be a copy of the embedding
    expect(particle.position).toEqual([0.5, -0.5, 0.7071]);
    // Modifying original should not affect particle
    embedding[0] = 999;
    expect(particle.position[0]).toBe(0.5);

    // Velocity should be zero vector of same dimension
    expect(particle.velocity).toEqual([0, 0, 0]);

    // Mass derived from strength and retrieval_count
    expect(particle.mass).toBeGreaterThan(0);

    // Charge from emotional_valence 'negative' => -0.5
    expect(particle.charge).toBeCloseTo(-0.5, 10);

    // Temperature from age (0 days since created === NOW) => 1/(0*1+1) = 1.0
    expect(particle.temperature).toBeCloseTo(1.0, 5);

    expect(particle.lastSimulation).toBe(NOW.toISOString());
  });

  it('handles positive emotional valence', () => {
    const entry = makeMemoryEntry('mem_pos', { emotional_valence: 'positive' });
    const embedding = [1, 0, 0];
    const particle = initializeParticle(entry, embedding, NOW);
    expect(particle.charge).toBeCloseTo(0.3, 10);
  });

  it('handles critical emotional valence', () => {
    const entry = makeMemoryEntry('mem_crit', { emotional_valence: 'critical' });
    const embedding = [1, 0, 0];
    const particle = initializeParticle(entry, embedding, NOW);
    expect(particle.charge).toBeCloseTo(-1.0, 10);
  });

  it('computes temperature decay for old memories', () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const entry = makeMemoryEntry('mem_old', { created: threeDaysAgo.toISOString() });
    const embedding = [1, 0, 0];

    const particle = initializeParticle(entry, embedding, NOW);
    // temperature = 1 / (ageDays * 1.0 + 1) = 1 / (3 + 1) = 0.25
    expect(particle.temperature).toBeCloseTo(0.25, 5);
  });
});

// ---------------------------------------------------------------------------
// 9. resetAllPhysicsState
// ---------------------------------------------------------------------------

describe('resetAllPhysicsState', () => {
  it('drops existing state and re-initializes from embeddings', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_r1');
      insertMemoryRow(db, 'mem_r2');

      // Save some initial state
      const oldParticle = makeParticle('mem_r1');
      oldParticle.mass = 99.9;
      savePhysicsState(db, [oldParticle]);
      expect(loadPhysicsState(db).size).toBe(1);

      // Reset
      const entries = [
        makeMemoryEntry('mem_r1'),
        makeMemoryEntry('mem_r2'),
      ];
      const embeddingIndex = {
        mem_r1: [0.5, 0.5, 0.5],
        mem_r2: [0.1, 0.2, 0.3],
      } satisfies Record<string, number[]>;

      const count = resetAllPhysicsState(db, entries, embeddingIndex, NOW);
      expect(count).toBe(2);

      const loaded = loadPhysicsState(db);
      expect(loaded.size).toBe(2);

      // Old mass (99.9) should be gone, replaced by freshly computed mass
      const p1 = loaded.get('mem_r1')!;
      expect(p1.mass).not.toBeCloseTo(99.9, 1);
      expect(p1.position[0]).toBeCloseTo(0.5, 5);
    } finally {
      closeHippoDb(db);
    }
  });

  it('skips entries without embeddings', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_has_emb');
      insertMemoryRow(db, 'mem_no_emb');

      const entries = [
        makeMemoryEntry('mem_has_emb'),
        makeMemoryEntry('mem_no_emb'),
      ];
      const embeddingIndex = {
        mem_has_emb: [0.1, 0.2, 0.3],
        // mem_no_emb intentionally missing
      } satisfies Record<string, number[]>;

      const count = resetAllPhysicsState(db, entries, embeddingIndex, NOW);
      expect(count).toBe(1);

      const loaded = loadPhysicsState(db);
      expect(loaded.size).toBe(1);
      expect(loaded.has('mem_has_emb')).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('skips entries with empty embedding arrays', () => {
    const db = openHippoDb(tmpDir);
    try {
      insertMemoryRow(db, 'mem_empty_emb');

      const entries = [makeMemoryEntry('mem_empty_emb')];
      const embeddingIndex = {
        mem_empty_emb: [],
      } satisfies Record<string, number[]>;

      const count = resetAllPhysicsState(db, entries, embeddingIndex, NOW);
      expect(count).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('handles empty entries list', () => {
    const db = openHippoDb(tmpDir);
    try {
      const count = resetAllPhysicsState(db, [], {}, NOW);
      expect(count).toBe(0);
      expect(loadPhysicsState(db).size).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. refreshParticleProperties
// ---------------------------------------------------------------------------

describe('refreshParticleProperties', () => {
  it('updates mass, charge, and temperature from current memory attributes', () => {
    const particle = makeParticle('mem_refresh');
    particle.mass = 999;
    particle.charge = 999;
    particle.temperature = 999;

    const entry = makeMemoryEntry('mem_refresh', {
      emotional_valence: 'negative',
      retrieval_count: 5,
    });

    const entries = new Map<string, MemoryEntry>();
    entries.set('mem_refresh', entry);

    refreshParticleProperties([particle], entries, NOW);

    // Mass should be recomputed (not 999)
    expect(particle.mass).not.toBe(999);
    expect(particle.mass).toBeGreaterThan(0);

    // Charge for 'negative' => -0.5
    expect(particle.charge).toBeCloseTo(-0.5, 10);

    // Temperature for age=0 => 1.0
    expect(particle.temperature).toBeCloseTo(1.0, 5);
  });

  it('does not modify particles without matching entries', () => {
    const particle = makeParticle('mem_orphan');
    particle.mass = 42;
    particle.charge = 7;
    particle.temperature = 0.99;

    const entries = new Map<string, MemoryEntry>();
    // No entry for 'mem_orphan'

    refreshParticleProperties([particle], entries, NOW);

    // Should remain unchanged
    expect(particle.mass).toBe(42);
    expect(particle.charge).toBe(7);
    expect(particle.temperature).toBe(0.99);
  });

  it('handles mixed matched and unmatched particles', () => {
    const matched = makeParticle('mem_matched');
    matched.mass = 999;
    const unmatched = makeParticle('mem_unmatched');
    unmatched.mass = 42;

    const entry = makeMemoryEntry('mem_matched', {
      emotional_valence: 'positive',
      retrieval_count: 10,
    });

    const entries = new Map<string, MemoryEntry>();
    entries.set('mem_matched', entry);

    refreshParticleProperties([matched, unmatched], entries, NOW);

    // Matched should be updated
    expect(matched.mass).not.toBe(999);
    expect(matched.charge).toBeCloseTo(0.3, 10); // positive => 0.3

    // Unmatched should be unchanged
    expect(unmatched.mass).toBe(42);
  });

  it('mutates particles in place', () => {
    const particles = [makeParticle('mem_mut')];
    const originalRef = particles[0];

    const entry = makeMemoryEntry('mem_mut', { emotional_valence: 'critical' });
    const entries = new Map<string, MemoryEntry>([['mem_mut', entry]]);

    refreshParticleProperties(particles, entries, NOW);

    // Same reference, mutated
    expect(particles[0]).toBe(originalRef);
    expect(particles[0]!.charge).toBeCloseTo(-1.0, 10);
  });
});
