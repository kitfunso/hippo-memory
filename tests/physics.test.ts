import { describe, it, expect } from 'vitest';
import {
  vecDot, vecNorm, vecScale, vecAdd, vecSub, vecZero, vecNormalize, vecClampMagnitude,
  computeMass, computeCharge, computeTemperature,
  queryGravityMagnitude, velocityAlignmentBonus, attractionForce, repulsionForce, dragForce,
  physicsScore, simulate, computeSystemEnergy, applyOutcomeFeedback,
  type PhysicsParticle, type ForceContext,
} from '../src/physics.js';
import { DEFAULT_PHYSICS_CONFIG } from '../src/physics-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParticle(overrides: Partial<PhysicsParticle> & { memoryId: string }): PhysicsParticle {
  return {
    position: [1, 0, 0],
    velocity: [0, 0, 0],
    mass: 1.0,
    charge: 0,
    temperature: 1.0,
    lastSimulation: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<ForceContext>): ForceContext {
  return {
    conflictPairs: new Map(),
    halfLives: new Map(),
    config: { ...DEFAULT_PHYSICS_CONFIG },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Vector math
// ---------------------------------------------------------------------------

describe('Vector math', () => {
  describe('vecDot', () => {
    it('computes dot product of two vectors', () => {
      expect(vecDot([1, 2, 3], [4, 5, 6])).toBe(32);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(vecDot([1, 0, 0], [0, 1, 0])).toBe(0);
    });

    it('returns negative for opposing vectors', () => {
      expect(vecDot([1, 0, 0], [-1, 0, 0])).toBe(-1);
    });
  });

  describe('vecNorm', () => {
    it('computes Euclidean norm', () => {
      expect(vecNorm([3, 4, 0])).toBe(5);
    });

    it('returns 0 for zero vector', () => {
      expect(vecNorm([0, 0, 0])).toBe(0);
    });

    it('returns 1 for unit vector', () => {
      expect(vecNorm([1, 0, 0])).toBe(1);
    });
  });

  describe('vecScale', () => {
    it('scales a vector by a scalar', () => {
      expect(vecScale([1, 2, 3], 2)).toEqual([2, 4, 6]);
    });

    it('scaling by 0 yields zero vector', () => {
      expect(vecScale([5, 10, 15], 0)).toEqual([0, 0, 0]);
    });

    it('negative scalar reverses direction', () => {
      const result = vecScale([1, -1, 0], -3);
      expect(result[0]).toBe(-3);
      expect(result[1]).toBe(3);
      expect(result[2]).toBeCloseTo(0, 10);
    });
  });

  describe('vecAdd', () => {
    it('adds two vectors element-wise', () => {
      expect(vecAdd([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
    });

    it('adding zero vector is identity', () => {
      expect(vecAdd([1, 2, 3], [0, 0, 0])).toEqual([1, 2, 3]);
    });
  });

  describe('vecSub', () => {
    it('subtracts two vectors element-wise', () => {
      expect(vecSub([4, 5, 6], [1, 2, 3])).toEqual([3, 3, 3]);
    });

    it('subtracting self yields zero', () => {
      expect(vecSub([7, 8, 9], [7, 8, 9])).toEqual([0, 0, 0]);
    });
  });

  describe('vecZero', () => {
    it('creates a zero vector of given dimension', () => {
      expect(vecZero(3)).toEqual([0, 0, 0]);
    });

    it('creates empty array for dim 0', () => {
      expect(vecZero(0)).toEqual([]);
    });

    it('creates higher-dimensional zero vector', () => {
      const z = vecZero(5);
      expect(z).toHaveLength(5);
      expect(z.every(v => v === 0)).toBe(true);
    });
  });

  describe('vecNormalize', () => {
    it('normalizes a vector to unit length', () => {
      const n = vecNormalize([3, 4, 0]);
      expect(vecNorm(n)).toBeCloseTo(1, 10);
      expect(n[0]).toBeCloseTo(0.6, 10);
      expect(n[1]).toBeCloseTo(0.8, 10);
    });

    it('returns zero vector for near-zero input', () => {
      const n = vecNormalize([0, 0, 0]);
      expect(n).toEqual([0, 0, 0]);
    });

    it('preserves direction', () => {
      const n = vecNormalize([10, 0, 0]);
      expect(n).toEqual([1, 0, 0]);
    });
  });

  describe('vecClampMagnitude', () => {
    it('returns original if magnitude <= maxMag', () => {
      const v = [1, 0, 0];
      const clamped = vecClampMagnitude(v, 5);
      // Should return the same reference since no clamp needed
      expect(clamped).toBe(v);
    });

    it('clamps to maxMag if magnitude exceeds it', () => {
      const clamped = vecClampMagnitude([6, 8, 0], 5);
      expect(vecNorm(clamped)).toBeCloseTo(5, 10);
    });

    it('preserves direction when clamping', () => {
      const clamped = vecClampMagnitude([6, 8, 0], 5);
      // Direction should be [0.6, 0.8, 0]
      expect(clamped[0]).toBeCloseTo(3, 10);
      expect(clamped[1]).toBeCloseTo(4, 10);
      expect(clamped[2]).toBeCloseTo(0, 10);
    });

    it('clamp at zero produces zero vector', () => {
      const clamped = vecClampMagnitude([1, 2, 3], 0);
      expect(vecNorm(clamped)).toBeCloseTo(0, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Property derivation
// ---------------------------------------------------------------------------

describe('Property derivation', () => {
  describe('computeMass', () => {
    it('increases with strength', () => {
      expect(computeMass(0.8, 0)).toBeGreaterThan(computeMass(0.2, 0));
    });

    it('increases logarithmically with retrieval count', () => {
      const m0 = computeMass(1, 0);
      const m10 = computeMass(1, 10);
      const m100 = computeMass(1, 100);
      expect(m10).toBeGreaterThan(m0);
      expect(m100).toBeGreaterThan(m10);
      // Logarithmic: gap narrows
      expect(m100 - m10).toBeLessThan(m10 - m0);
    });

    it('never drops below 0.01', () => {
      expect(computeMass(0, 0)).toBe(0.01);
      expect(computeMass(0.001, 0)).toBeGreaterThanOrEqual(0.01);
    });

    it('formula matches expected value', () => {
      // strength=1.0, retrievalCount=3 -> 1.0 * (1 + 0.1 * log2(4)) = 1.0 * 1.2 = 1.2
      expect(computeMass(1.0, 3)).toBeCloseTo(1.2, 5);
    });
  });

  describe('computeCharge', () => {
    it('neutral = 0', () => {
      expect(computeCharge('neutral')).toBe(0);
    });

    it('positive = 0.3', () => {
      expect(computeCharge('positive')).toBe(0.3);
    });

    it('negative = -0.5', () => {
      expect(computeCharge('negative')).toBe(-0.5);
    });

    it('critical = -1.0', () => {
      expect(computeCharge('critical')).toBe(-1.0);
    });
  });

  describe('computeTemperature', () => {
    it('returns 1 for brand new memory (age=0)', () => {
      expect(computeTemperature(0, 1.0)).toBe(1);
    });

    it('decays with age', () => {
      const t1 = computeTemperature(1, 1.0);
      const t7 = computeTemperature(7, 1.0);
      expect(t7).toBeLessThan(t1);
      expect(t1).toBeLessThan(1);
    });

    it('higher decay rate = faster cooling', () => {
      const slow = computeTemperature(5, 0.5);
      const fast = computeTemperature(5, 2.0);
      expect(fast).toBeLessThan(slow);
    });

    it('formula matches: 1 / (age * decay + 1)', () => {
      // age=4, decay=1.0 -> 1/(4+1) = 0.2
      expect(computeTemperature(4, 1.0)).toBeCloseTo(0.2, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Force computations
// ---------------------------------------------------------------------------

describe('Force computations', () => {
  describe('queryGravityMagnitude', () => {
    it('high cosine similarity = high force', () => {
      const p = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const query = [1, 0, 0]; // identical direction
      const force = queryGravityMagnitude(p, query, 2.0);
      // G_query * mass * cos^2 = 2 * 1 * 1 = 2
      expect(force).toBeCloseTo(2.0, 5);
    });

    it('orthogonal vectors = zero force', () => {
      const p = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const force = queryGravityMagnitude(p, [0, 1, 0], 2.0);
      expect(force).toBe(0);
    });

    it('negative cosine (opposing) = zero force', () => {
      const p = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const force = queryGravityMagnitude(p, [-1, 0, 0], 2.0);
      expect(force).toBe(0);
    });

    it('mass scales force linearly', () => {
      const p1 = makeParticle({ memoryId: 'a', position: [1, 0, 0], mass: 1 });
      const p2 = makeParticle({ memoryId: 'b', position: [1, 0, 0], mass: 3 });
      const query = [1, 0, 0];
      const f1 = queryGravityMagnitude(p1, query, 2.0);
      const f2 = queryGravityMagnitude(p2, query, 2.0);
      expect(f2).toBeCloseTo(f1 * 3, 10);
    });

    it('G_query scales force linearly', () => {
      const p = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const query = [1, 0, 0];
      const f1 = queryGravityMagnitude(p, query, 1.0);
      const f2 = queryGravityMagnitude(p, query, 4.0);
      expect(f2).toBeCloseTo(f1 * 4, 10);
    });

    it('partial cosine gives cos^2 scaling', () => {
      // cos(45deg) ~ 0.707, cos^2 ~ 0.5
      const p = makeParticle({ memoryId: 'a', position: vecNormalize([1, 1, 0]) });
      const query = [1, 0, 0];
      const force = queryGravityMagnitude(p, query, 1.0);
      expect(force).toBeCloseTo(0.5, 1);
    });
  });

  describe('velocityAlignmentBonus', () => {
    it('aligned velocity = positive bonus', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [1, 0, 0] });
      const bonus = velocityAlignmentBonus(p, [1, 0, 0]);
      expect(bonus).toBeCloseTo(1.0, 5);
    });

    it('orthogonal velocity = 0', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [0, 1, 0] });
      const bonus = velocityAlignmentBonus(p, [1, 0, 0]);
      expect(bonus).toBeCloseTo(0, 5);
    });

    it('opposing velocity = 0 (clamped)', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [-1, 0, 0] });
      const bonus = velocityAlignmentBonus(p, [1, 0, 0]);
      expect(bonus).toBe(0);
    });

    it('zero velocity = 0', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [0, 0, 0] });
      const bonus = velocityAlignmentBonus(p, [1, 0, 0]);
      expect(bonus).toBe(0);
    });

    it('partially aligned velocity gives intermediate value', () => {
      const p = makeParticle({ memoryId: 'a', velocity: vecNormalize([1, 1, 0]) });
      const bonus = velocityAlignmentBonus(p, [1, 0, 0]);
      // cos(45) ~ 0.707
      expect(bonus).toBeCloseTo(Math.SQRT1_2, 2);
    });
  });

  describe('attractionForce', () => {
    it('similar particles attract (cosine > 0)', () => {
      const pi = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]) });
      const pj = makeParticle({ memoryId: 'b', position: vecNormalize([1, 0.2, 0]) });
      const force = attractionForce(pi, pj, 0.01);
      expect(vecNorm(force)).toBeGreaterThan(0);
    });

    it('orthogonal particles get zero attraction', () => {
      const pi = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const pj = makeParticle({ memoryId: 'b', position: [0, 1, 0] });
      const force = attractionForce(pi, pj, 0.01);
      expect(vecNorm(force)).toBe(0);
    });

    it('opposing particles get zero attraction', () => {
      const pi = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const pj = makeParticle({ memoryId: 'b', position: [-1, 0, 0] });
      const force = attractionForce(pi, pj, 0.01);
      expect(vecNorm(force)).toBe(0);
    });

    it('magnitude scales with mass product', () => {
      const pi1 = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]), mass: 1 });
      const pj1 = makeParticle({ memoryId: 'b', position: vecNormalize([1, 0.2, 0]), mass: 1 });
      const pi2 = makeParticle({ memoryId: 'c', position: vecNormalize([1, 0.1, 0]), mass: 2 });
      const pj2 = makeParticle({ memoryId: 'd', position: vecNormalize([1, 0.2, 0]), mass: 3 });
      const f1 = vecNorm(attractionForce(pi1, pj1, 1.0));
      const f2 = vecNorm(attractionForce(pi2, pj2, 1.0));
      expect(f2).toBeCloseTo(f1 * 6, 5);
    });

    it('co-located particles get random perturbation', () => {
      const pi = makeParticle({ memoryId: 'a', position: [1, 0, 0], mass: 1 });
      const pj = makeParticle({ memoryId: 'b', position: [1, 0, 0], mass: 1 });
      const force = attractionForce(pi, pj, 1.0);
      // Co-located particles now get a random direction instead of zero force
      expect(vecNorm(force)).toBeGreaterThan(0);
    });

    it('force direction points from i toward j', () => {
      const pi = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const pj = makeParticle({ memoryId: 'b', position: vecNormalize([1, 1, 0]) });
      const force = attractionForce(pi, pj, 1.0);
      // Should have positive y component (toward pj)
      expect(force[1]).toBeGreaterThan(0);
    });
  });

  describe('repulsionForce', () => {
    it('pushes particles apart', () => {
      const pi = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]) });
      const pj = makeParticle({ memoryId: 'b', position: vecNormalize([1, 0.2, 0]) });
      const force = repulsionForce(pi, pj, 0.5);
      // Force should point from j toward i (away from j)
      // pi is at [~1, ~0.1, 0], pj is at [~1, ~0.2, 0]
      // Direction away from pj should have negative y component relative to pj
      expect(vecNorm(force)).toBeGreaterThan(0);
    });

    it('scales with mass product', () => {
      const pi1 = makeParticle({ memoryId: 'a', position: [1, 0, 0], mass: 1 });
      const pj1 = makeParticle({ memoryId: 'b', position: [0, 1, 0], mass: 1 });
      const pi2 = makeParticle({ memoryId: 'c', position: [1, 0, 0], mass: 2 });
      const pj2 = makeParticle({ memoryId: 'd', position: [0, 1, 0], mass: 3 });
      const f1 = vecNorm(repulsionForce(pi1, pj1, 1.0));
      const f2 = vecNorm(repulsionForce(pi2, pj2, 1.0));
      expect(f2).toBeCloseTo(f1 * 6, 5);
    });

    it('scales with inverse cosine_distance^2', () => {
      // Close particles (high cos -> small distance) => stronger repulsion
      const close_i = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.05, 0]) });
      const close_j = makeParticle({ memoryId: 'b', position: vecNormalize([1, 0.1, 0]) });
      const far_i = makeParticle({ memoryId: 'c', position: [1, 0, 0] });
      const far_j = makeParticle({ memoryId: 'd', position: [0, 1, 0] });
      const fClose = vecNorm(repulsionForce(close_i, close_j, 1.0));
      const fFar = vecNorm(repulsionForce(far_i, far_j, 1.0));
      expect(fClose).toBeGreaterThan(fFar);
    });

    it('direction points away from other particle', () => {
      const pi = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const pj = makeParticle({ memoryId: 'b', position: [0, 1, 0] });
      const force = repulsionForce(pi, pj, 1.0);
      // Direction is normalize(pi.pos - pj.pos) = normalize([1,-1,0])
      expect(force[0]).toBeGreaterThan(0);
      expect(force[1]).toBeLessThan(0);
    });
  });

  describe('dragForce', () => {
    it('opposes velocity direction', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [1, 2, 3] });
      const fd = dragForce(p, 0.3, 7);
      // Each component should be opposite sign of velocity
      expect(fd[0]).toBeLessThan(0);
      expect(fd[1]).toBeLessThan(0);
      expect(fd[2]).toBeLessThan(0);
    });

    it('zero velocity gives zero drag', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [0, 0, 0] });
      const fd = dragForce(p, 0.3, 7);
      expect(vecNorm(fd)).toBe(0);
    });

    it('higher drag coefficient = stronger drag', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [1, 0, 0] });
      const f1 = vecNorm(dragForce(p, 0.1, 7));
      const f2 = vecNorm(dragForce(p, 0.5, 7));
      expect(f2).toBeGreaterThan(f1);
    });

    it('longer half-life = weaker drag', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [1, 0, 0] });
      const fShort = vecNorm(dragForce(p, 0.3, 2));
      const fLong = vecNorm(dragForce(p, 0.3, 30));
      expect(fShort).toBeGreaterThan(fLong);
    });

    it('half-life below 1 is clamped to 1', () => {
      const p = makeParticle({ memoryId: 'a', velocity: [1, 0, 0] });
      const f0 = dragForce(p, 0.3, 0);
      const f1 = dragForce(p, 0.3, 1);
      expect(f0).toEqual(f1);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Scoring
// ---------------------------------------------------------------------------

describe('Scoring', () => {
  describe('physicsScore', () => {
    it('returns results sorted by score (highest first)', () => {
      const particles = [
        makeParticle({ memoryId: 'low', position: [0, 1, 0] }),
        makeParticle({ memoryId: 'high', position: [1, 0, 0] }),
        makeParticle({ memoryId: 'mid', position: vecNormalize([1, 1, 0]) }),
      ];
      const query = [1, 0, 0];
      const results = physicsScore(particles, query, { ...DEFAULT_PHYSICS_CONFIG });
      expect(results[0].memoryId).toBe('high');
      expect(results[results.length - 1].memoryId).toBe('low');
      // Verify sorted
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].finalScore).toBeGreaterThanOrEqual(results[i].finalScore);
      }
    });

    it('returns empty array for no particles', () => {
      const results = physicsScore([], [1, 0, 0], { ...DEFAULT_PHYSICS_CONFIG });
      expect(results).toEqual([]);
    });

    it('returns empty array for empty query', () => {
      const particles = [makeParticle({ memoryId: 'a' })];
      const results = physicsScore(particles, [], { ...DEFAULT_PHYSICS_CONFIG });
      expect(results).toEqual([]);
    });

    it('returns finite zero scores for mismatched query dimensions', () => {
      const particles = [makeParticle({ memoryId: 'a', position: [1, 0, 0], velocity: [1, 0, 0] })];
      const results = physicsScore(particles, [1, 0], { ...DEFAULT_PHYSICS_CONFIG });
      expect(results).toHaveLength(1);
      expect(results[0].baseScore).toBe(0);
      expect(Number.isFinite(results[0].finalScore)).toBe(true);
    });

    it('velocity alignment contributes to score', () => {
      const still = makeParticle({ memoryId: 'still', position: [1, 0, 0], velocity: [0, 0, 0] });
      const moving = makeParticle({ memoryId: 'moving', position: [1, 0, 0], velocity: [0.1, 0, 0] });
      const query = [1, 0, 0];
      const config = { ...DEFAULT_PHYSICS_CONFIG, momentum_weight: 0.5 };
      const results = physicsScore([still, moving], query, config);
      const movingResult = results.find(r => r.memoryId === 'moving')!;
      const stillResult = results.find(r => r.memoryId === 'still')!;
      expect(movingResult.finalScore).toBeGreaterThan(stillResult.finalScore);
    });

    it('all results have expected shape', () => {
      const particles = [
        makeParticle({ memoryId: 'a', position: [1, 0, 0] }),
        makeParticle({ memoryId: 'b', position: [0, 1, 0] }),
      ];
      const results = physicsScore(particles, [1, 0, 0], { ...DEFAULT_PHYSICS_CONFIG });
      for (const r of results) {
        expect(r).toHaveProperty('memoryId');
        expect(r).toHaveProperty('baseScore');
        expect(r).toHaveProperty('clusterAmplification');
        expect(r).toHaveProperty('finalScore');
        expect(typeof r.baseScore).toBe('number');
        expect(r.clusterAmplification).toBeGreaterThanOrEqual(1.0);
      }
    });
  });

  describe('Cluster amplification', () => {
    it('nearby high-scoring memories reinforce each other', () => {
      // Create a cluster of 3 similar particles and one far away
      const cluster = [
        makeParticle({ memoryId: 'c1', position: vecNormalize([1, 0.01, 0]) }),
        makeParticle({ memoryId: 'c2', position: vecNormalize([1, 0.02, 0]) }),
        makeParticle({ memoryId: 'c3', position: vecNormalize([1, 0.03, 0]) }),
      ];
      const isolated = makeParticle({ memoryId: 'iso', position: vecNormalize([1, 0.04, 0]) });

      const query = [1, 0, 0];
      const config = {
        ...DEFAULT_PHYSICS_CONFIG,
        cluster_threshold: 0.99, // very tight threshold for the close cluster
        cluster_top_k: 10,
        interference_gain: 1.0,
      };

      // Score cluster particles
      const clusterResults = physicsScore([...cluster, isolated], query, config);
      const c1Result = clusterResults.find(r => r.memoryId === 'c1')!;
      // c1 should get cluster amplification > 1 from c2 and c3
      expect(c1Result.clusterAmplification).toBeGreaterThan(1.0);
    });

    it('isolated memory gets amplification of 1.0', () => {
      // Two very distant particles -- below threshold
      const particles = [
        makeParticle({ memoryId: 'a', position: [1, 0, 0] }),
        makeParticle({ memoryId: 'b', position: [0, 1, 0] }),
      ];
      const query = vecNormalize([1, 1, 0]);
      const config = {
        ...DEFAULT_PHYSICS_CONFIG,
        cluster_threshold: 0.95, // high threshold; cos([1,0,0],[0,1,0]) = 0
        cluster_top_k: 10,
      };
      const results = physicsScore(particles, query, config);
      for (const r of results) {
        expect(r.clusterAmplification).toBeCloseTo(1.0, 5);
      }
    });

    it('single particle gets no amplification', () => {
      const particles = [makeParticle({ memoryId: 'solo', position: [1, 0, 0] })];
      const results = physicsScore(particles, [1, 0, 0], { ...DEFAULT_PHYSICS_CONFIG });
      expect(results[0].clusterAmplification).toBe(1.0);
      expect(results[0].finalScore).toBe(results[0].baseScore);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Simulation
// ---------------------------------------------------------------------------

describe('Simulation', () => {
  describe('simulate', () => {
    it('empty particles returns zero stats', () => {
      const stats = simulate([], makeCtx());
      expect(stats.particleCount).toBe(0);
      expect(stats.avgVelocityMagnitude).toBe(0);
      expect(stats.maxVelocityMagnitude).toBe(0);
      expect(stats.energy.kinetic).toBe(0);
      expect(stats.energy.potential).toBe(0);
      expect(stats.energy.total).toBe(0);
      expect(stats.substepsRun).toBe(0);
    });

    it('particles move after simulation', () => {
      const p1 = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]) });
      const p2 = makeParticle({ memoryId: 'b', position: vecNormalize([0.8, 0.6, 0]) });
      const posBefore1 = [...p1.position];
      const posBefore2 = [...p2.position];

      const ctx = makeCtx();
      simulate([p1, p2], ctx);

      // At least one particle should have moved
      const moved1 = p1.position.some((v, i) => Math.abs(v - posBefore1[i]) > 1e-15);
      const moved2 = p2.position.some((v, i) => Math.abs(v - posBefore2[i]) > 1e-15);
      expect(moved1 || moved2).toBe(true);
    });

    it('velocity stays clamped to max_velocity', () => {
      const p1 = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]), velocity: [0.05, 0.05, 0] });
      const p2 = makeParticle({ memoryId: 'b', position: vecNormalize([0.9, 0.4, 0]), velocity: [-0.05, 0.05, 0] });

      const ctx = makeCtx({
        config: { ...DEFAULT_PHYSICS_CONFIG, substeps: 50, max_velocity: 0.1 },
      });
      simulate([p1, p2], ctx);

      expect(vecNorm(p1.velocity)).toBeLessThanOrEqual(0.1 + 1e-10);
      expect(vecNorm(p2.velocity)).toBeLessThanOrEqual(0.1 + 1e-10);
    });

    it('positions stay normalized to unit sphere', () => {
      const particles = [
        makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.3, 0.5]) }),
        makeParticle({ memoryId: 'b', position: vecNormalize([0.2, 1, 0.1]) }),
        makeParticle({ memoryId: 'c', position: vecNormalize([0.5, 0.5, 1]) }),
      ];
      const ctx = makeCtx({ config: { ...DEFAULT_PHYSICS_CONFIG, substeps: 20 } });
      simulate(particles, ctx);

      for (const p of particles) {
        expect(vecNorm(p.position)).toBeCloseTo(1.0, 5);
      }
    });

    it('energy does not increase over many steps (drag removes energy)', () => {
      const particles = [
        makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]), velocity: [0.05, 0, 0] }),
        makeParticle({ memoryId: 'b', position: vecNormalize([0.8, 0.6, 0]), velocity: [0, 0.05, 0] }),
      ];

      const config = { ...DEFAULT_PHYSICS_CONFIG, substeps: 5, drag: 0.5 };
      const ctx1 = makeCtx({ config });

      // Run first batch
      simulate(particles, ctx1);
      const energyAfterFirst = computeSystemEnergy(particles, config.G_memory).kinetic;

      // Run second batch
      const ctx2 = makeCtx({ config });
      simulate(particles, ctx2);
      const energyAfterSecond = computeSystemEnergy(particles, config.G_memory).kinetic;

      // Run third batch
      const ctx3 = makeCtx({ config });
      simulate(particles, ctx3);
      const energyAfterThird = computeSystemEnergy(particles, config.G_memory).kinetic;

      // Kinetic energy should generally decrease due to drag
      // At least one of these should show decrease
      expect(energyAfterThird).toBeLessThanOrEqual(energyAfterFirst + 1e-6);
    });

    it('returns correct particle count and substeps', () => {
      const particles = [
        makeParticle({ memoryId: 'a', position: [1, 0, 0] }),
        makeParticle({ memoryId: 'b', position: [0, 1, 0] }),
      ];
      const config = { ...DEFAULT_PHYSICS_CONFIG, substeps: 10 };
      const stats = simulate(particles, makeCtx({ config }));
      expect(stats.particleCount).toBe(2);
      expect(stats.substepsRun).toBe(10);
    });

    it('updates lastSimulation timestamp', () => {
      const oldTime = '2020-01-01T00:00:00.000Z';
      const p = makeParticle({ memoryId: 'a', lastSimulation: oldTime });
      simulate([p], makeCtx());
      expect(p.lastSimulation).not.toBe(oldTime);
      // Should be a valid ISO date
      expect(new Date(p.lastSimulation).getTime()).toBeGreaterThan(new Date(oldTime).getTime());
    });

    it('single particle with drag slows down', () => {
      const p = makeParticle({ memoryId: 'a', position: [1, 0, 0], velocity: [0, 0.08, 0] });
      const initialSpeed = vecNorm(p.velocity);
      const ctx = makeCtx({
        config: { ...DEFAULT_PHYSICS_CONFIG, substeps: 20, drag: 1.0 },
        halfLives: new Map([['a', 1]]),
      });
      simulate([p], ctx);
      expect(vecNorm(p.velocity)).toBeLessThan(initialSpeed);
    });
  });

  describe('computeSystemEnergy', () => {
    it('kinetic energy = 0.5 * m * v^2', () => {
      const p = makeParticle({ memoryId: 'a', mass: 2, velocity: [3, 4, 0] });
      const energy = computeSystemEnergy([p], 0.01);
      // KE = 0.5 * 2 * 25 = 25
      expect(energy.kinetic).toBeCloseTo(25, 5);
    });

    it('potential energy is negative for similar particles', () => {
      const p1 = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]) });
      const p2 = makeParticle({ memoryId: 'b', position: vecNormalize([1, 0.2, 0]) });
      const energy = computeSystemEnergy([p1, p2], 1.0);
      expect(energy.potential).toBeLessThan(0);
    });

    it('potential energy is 0 for orthogonal particles', () => {
      const p1 = makeParticle({ memoryId: 'a', position: [1, 0, 0] });
      const p2 = makeParticle({ memoryId: 'b', position: [0, 1, 0] });
      const energy = computeSystemEnergy([p1, p2], 1.0);
      expect(energy.potential).toBeCloseTo(0, 10);
    });

    it('total = kinetic + potential', () => {
      const p1 = makeParticle({ memoryId: 'a', position: vecNormalize([1, 0.1, 0]), mass: 2, velocity: [1, 0, 0] });
      const p2 = makeParticle({ memoryId: 'b', position: vecNormalize([1, 0.2, 0]), mass: 1, velocity: [0, 1, 0] });
      const energy = computeSystemEnergy([p1, p2], 0.5);
      expect(energy.total).toBeCloseTo(energy.kinetic + energy.potential, 10);
    });

    it('empty particles = zero energy', () => {
      const energy = computeSystemEnergy([], 1.0);
      expect(energy.kinetic).toBe(0);
      expect(energy.potential).toBe(0);
      expect(energy.total).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Outcome feedback
// ---------------------------------------------------------------------------

describe('Outcome feedback', () => {
  describe('applyOutcomeFeedback', () => {
    it('good outcome nudges position toward query', () => {
      const p = makeParticle({ memoryId: 'a', position: [1, 0, 0], temperature: 1.0 });
      const query = [0, 1, 0];
      const posBefore = [...p.position];

      applyOutcomeFeedback(p, query, true, 0.1);

      // After nudge toward [0,1,0], the y component should increase
      expect(p.position[1]).toBeGreaterThan(posBefore[1]);
      // Position should still be normalized
      expect(vecNorm(p.position)).toBeCloseTo(1.0, 10);
    });

    it('bad outcome nudges position away from query', () => {
      const p = makeParticle({ memoryId: 'a', position: vecNormalize([1, 1, 0]), temperature: 1.0 });
      const query = [0, 1, 0];
      const cosBefore = vecDot(p.position, vecNormalize(query));

      applyOutcomeFeedback(p, query, false, 0.1);

      const cosAfter = vecDot(p.position, vecNormalize(query));
      // Should be farther from query direction
      expect(cosAfter).toBeLessThan(cosBefore);
      // Position should still be normalized
      expect(vecNorm(p.position)).toBeCloseTo(1.0, 10);
    });

    it('cold particle (low temperature) barely moves', () => {
      const pHot = makeParticle({ memoryId: 'hot', position: [1, 0, 0], temperature: 1.0 });
      const pCold = makeParticle({ memoryId: 'cold', position: [1, 0, 0], temperature: 0.01 });
      const query = [0, 1, 0];

      applyOutcomeFeedback(pHot, query, true, 0.1);
      applyOutcomeFeedback(pCold, query, true, 0.1);

      // Hot particle should move more (higher y component)
      expect(pHot.position[1]).toBeGreaterThan(pCold.position[1]);
    });

    it('feedbackAlpha controls nudge magnitude', () => {
      const pSmall = makeParticle({ memoryId: 'sm', position: [1, 0, 0], temperature: 1.0 });
      const pLarge = makeParticle({ memoryId: 'lg', position: [1, 0, 0], temperature: 1.0 });
      const query = [0, 1, 0];

      applyOutcomeFeedback(pSmall, query, true, 0.001);
      applyOutcomeFeedback(pLarge, query, true, 0.5);

      expect(pLarge.position[1]).toBeGreaterThan(pSmall.position[1]);
    });

    it('result is always normalized to unit sphere', () => {
      const p = makeParticle({ memoryId: 'a', position: vecNormalize([0.5, 0.5, 0.5]), temperature: 1.0 });
      applyOutcomeFeedback(p, [1, 0, 0], true, 0.5);
      expect(vecNorm(p.position)).toBeCloseTo(1.0, 10);

      applyOutcomeFeedback(p, [0, 0, 1], false, 0.5);
      expect(vecNorm(p.position)).toBeCloseTo(1.0, 10);
    });
  });
});
