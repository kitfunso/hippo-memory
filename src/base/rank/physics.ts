/**
 * Memory-as-Physics engine: pure math (forces, Velocity Verlet integration, physics-based scoring, cluster
 * amplification), no I/O.
 * Memories are particles on the unit hypersphere in embedding space (384-dim); query gravity, attraction, conflict
 * repulsion and drag act on them, and nearby high-scoring memories amplify each other. */

import { cosineOf } from './cosine.js';
import { evalNow, NO_STRENGTH_ABLATION, type StrengthAblation } from '../memory/ablation.js';
import {
  calculateStrength,
  FALLBACK_HALF_LIFE_DAYS,
  type EmotionalValence,
  type MemoryEntry,
  type StrengthOptions,
} from '../memory/memory.js';
import { DAY_MS } from '../util/time.js';
import type { PhysicsConfig } from './physics-config.js';
import { comparePhysicsResultsBy } from './compare.js';

export interface PhysicsParticle {
  memoryId: string;
  position: number[]; // 384-dim, unit-normalized
  velocity: number[]; // 384-dim
  mass: number;
  charge: number;
  temperature: number;
  lastSimulation: string; // ISO 8601
}

export interface ScoredPhysicsResult {
  memoryId: string;
  baseScore: number;
  clusterAmplification: number;
  finalScore: number;
}

export interface SystemEnergy {
  kinetic: number;
  potential: number;
  total: number;
}

export interface SimulationStats {
  particleCount: number;
  avgVelocityMagnitude: number;
  maxVelocityMagnitude: number;
  substepsRun: number;
}

// Floors that stop a near-zero mass or a coincident pair from dividing a force by about zero.
const MIN_MASS = 0.01;
const MIN_COSINE_DISTANCE = 0.01;
// Mass gained per doubling of the retrieval count.
const RETRIEVAL_MASS_GAIN = 0.1;
const NEAR_ZERO = 1e-10;

export function vecDot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function vecNorm(v: number[]): number {
  return Math.sqrt(vecDot(v, v));
}

export function vecScale(v: number[], s: number): number[] {
  const out = v.slice();
  for (let i = 0; i < v.length; i++) out[i] = v[i] * s;
  return out;
}

export function vecZero(dim: number): number[] {
  return Array<number>(dim).fill(0);
}

/** Normalize to unit length. Returns zero vector if magnitude < epsilon. */
export function vecNormalize(v: number[]): number[] {
  const mag = vecNorm(v);
  if (mag < NEAR_ZERO) return vecZero(v.length);
  return vecScale(v, 1 / mag);
}

const CHARGE_MAP = {
  neutral: 0,
  positive: 0.3,
  negative: -0.5,
  critical: -1.0,
} satisfies Record<EmotionalValence, number>;

export function computeMass(
  strength: number,
  retrievalCount: number,
  ablation: StrengthAblation = NO_STRENGTH_ABLATION,
): number {
  // EVAL-ONLY ablation (ablation.ts): under the recall-boost flag mass ignores retrieval history, which would otherwise
  // leak strengthening into the ablated arm's physics-pool rankings (query gravity ranks by mass). Covers both init and
  // refresh callers in physics-state.ts.
  const effectiveCount = ablation.recallBoost ? 0 : retrievalCount;
  return Math.max(MIN_MASS, strength * (1 + RETRIEVAL_MASS_GAIN * Math.log2(effectiveCount + 1)));
}

export function computeCharge(valence: EmotionalValence): number {
  return CHARGE_MAP[valence] ?? 0;
}

export function computeTemperature(ageDays: number, temperatureDecay: number): number {
  return 1 / (ageDays * temperatureDecay + 1);
}

/**
 * Query gravity (retrieval-time, virtual: does not move the particle): scalar ranking magnitude F = G_Q * mass * max(0,
 * cosine(pos, query))^2.
 */
export function queryGravityMagnitude(particle: PhysicsParticle, queryEmbedding: number[], gQuery: number): number {
  const cos = cosineOf(particle.position, queryEmbedding);
  return gQuery * particle.mass * Math.pow(Math.max(0, cos), 2);
}

/** Momentum bonus in [0, 1]: how aligned the particle's velocity is with the query direction. */
export function velocityAlignmentBonus(particle: PhysicsParticle, queryEmbedding: number[]): number {
  if (particle.velocity.length === 0 || particle.velocity.length !== queryEmbedding.length) return 0;
  const velMag = vecNorm(particle.velocity);
  const qNorm = vecNorm(queryEmbedding);
  if (velMag < NEAR_ZERO || qNorm < NEAR_ZERO) return 0;
  const alignment = vecDot(particle.velocity, queryEmbedding) / (velMag * qNorm);
  return Math.max(0, alignment);
}

/**
 * Attraction force on particle i from j (consolidation-time): G_M m_i m_j max(0, cosine)^3, directed along (pos_j -
 * pos_i) projected tangent to the unit sphere at pos_i (positions are re-normalized to the sphere after integration).
 * Adds into `out` (a fresh zero vector by default) using `diff` as scratch.
 */
export function attractionForce(
  pi: PhysicsParticle,
  pj: PhysicsParticle,
  gMemory: number,
  out: number[] = vecZero(pi.position.length),
  diff: number[] = vecZero(pi.position.length),
): number[] {
  const cos = cosineOf(pi.position, pj.position);
  if (cos <= 0) return out;

  const magnitude = gMemory * pi.mass * pj.mass * Math.pow(cos, 3);
  // Direction: from i toward j (tangent projection handled by normalization after integration)
  for (let k = 0; k < out.length; k++) diff[k] = pj.position[k] - pi.position[k];
  const norm = vecNorm(diff);
  if (norm < NEAR_ZERO) return out;
  const inv = 1 / norm;
  for (let k = 0; k < out.length; k++) out[k] += diff[k] * inv * magnitude;
  return out;
}

/**
 * Conflict repulsion on i away from j (consolidation-time): K_R * m_i * m_j / max(0.01, cosine_distance)^2, where
 * cosine_distance = 1 - cosine_similarity. Adds into `out` (a fresh zero vector by default) using `diff` as scratch.
 */
export function repulsionForce(
  pi: PhysicsParticle,
  pj: PhysicsParticle,
  kRepulsion: number,
  out: number[] = vecZero(pi.position.length),
  diff: number[] = vecZero(pi.position.length),
): number[] {
  const cos = cosineOf(pi.position, pj.position);
  const dist = Math.max(MIN_COSINE_DISTANCE, 1 - cos);
  const magnitude = (kRepulsion * pi.mass * pj.mass) / (dist * dist);
  // Direction: away from j
  for (let k = 0; k < out.length; k++) diff[k] = pi.position[k] - pj.position[k];
  const norm = vecNorm(diff);
  if (norm < NEAR_ZERO) {
    for (let k = 0; k < out.length; k++) {
      out[k] += 0;
    }
    return out;
  }
  const inv = 1 / norm;
  for (let k = 0; k < out.length; k++) out[k] += diff[k] * inv * magnitude;
  return out;
}

/**
 * Drag force (consolidation-time): -drag * velocity / max(1, effectiveHalfLife), with effectiveHalfLife from the
 * memory's current half_life_days. Adds into `out`, a fresh zero vector by default.
 */
export function dragForce(
  particle: PhysicsParticle,
  drag: number,
  effectiveHalfLife: number,
  out: number[] = vecZero(particle.velocity.length),
): number[] {
  const damping = -(drag / Math.max(1, effectiveHalfLife));
  for (let k = 0; k < out.length; k++) out[k] += particle.velocity[k] * damping;
  return out;
}

export interface ForceContext {
  /** Map of memory ID -> list of conflicting memory IDs */
  conflictPairs: Map<string, Set<string>>;
  /** Map of memory ID -> effective half-life days */
  halfLives: Map<string, number>;
  config: PhysicsConfig;
}

/** Zeroes `net`, then accumulates the net force on particle i into it; `diff` is the caller's scratch. */
function computeNetForce(i: number, particles: PhysicsParticle[], ctx: ForceContext, net: number[], diff: number[]) {
  const pi = particles[i];
  net.fill(0);
  const conflicts = ctx.conflictPairs.get(pi.memoryId);

  for (let j = 0; j < particles.length; j++) {
    if (i === j) continue;
    const pj = particles[j];

    attractionForce(pi, pj, ctx.config.gMemory, net, diff);

    if (conflicts?.has(pj.memoryId)) repulsionForce(pi, pj, ctx.config.kRepulsion, net, diff);
  }

  dragForce(pi, ctx.config.drag, ctx.halfLives.get(pi.memoryId) ?? FALLBACK_HALF_LIFE_DAYS, net);
}

/** Acceleration of every particle (net force over mass) into `into`, one preallocated vector each. */
function computeAccelerations(particles: PhysicsParticle[], ctx: ForceContext, into: number[][], diff: number[]): void {
  for (let i = 0; i < particles.length; i++) {
    const accel = into[i];
    computeNetForce(i, particles, ctx, accel, diff);
    const inv = 1 / Math.max(MIN_MASS, particles[i].mass);
    for (let k = 0; k < accel.length; k++) accel[k] *= inv;
  }
}

/** vecNormalize in place. */
function normalizeInPlace(v: number[]): void {
  const mag = vecNorm(v);
  if (mag < NEAR_ZERO) {
    v.fill(0);
    return;
  }
  const inv = 1 / mag;
  for (let k = 0; k < v.length; k++) v[k] *= inv;
}

/** vecClampMagnitude in place. */
function clampInPlace(v: number[], maxMag: number): void {
  const mag = vecNorm(v);
  if (mag <= maxMag) return;
  const scale = maxMag / mag;
  for (let k = 0; k < v.length; k++) v[k] *= scale;
}

/** One Velocity Verlet step for all particles; the vectors of particles, `accelerations` and `next` change in place,
 * and `next` holds the new accelerations for the caller to swap in. */
function verletStep(
  particles: PhysicsParticle[],
  accelerations: number[][],
  next: number[][],
  ctx: ForceContext,
  diff: number[],
): void {
  const dt = ctx.config.dt;
  const maxVel = ctx.config.maxVelocity;
  const halfDt2 = 0.5 * dt * dt;

  for (let i = 0; i < particles.length; i++) {
    const { position, velocity } = particles[i];
    // Position update: pos += vel*dt + 0.5*accel*dt^2
    for (let k = 0; k < position.length; k++) {
      position[k] = position[k] + velocity[k] * dt + accelerations[i][k] * halfDt2;
    }
  }

  computeAccelerations(particles, ctx, next, diff);

  // Velocity update: vel += 0.5*(accel_old + accel_new)*dt
  for (let i = 0; i < particles.length; i++) {
    const { position, velocity } = particles[i];
    for (let k = 0; k < velocity.length; k++) {
      velocity[k] = velocity[k] + (accelerations[i][k] + next[i][k]) * 0.5 * dt;
    }
    // Stability: clamp velocity and normalize position to unit sphere
    clampInPlace(velocity, maxVel);
    normalizeInPlace(position);
  }
}

/** Full physics simulation for one sleep cycle; mutates particles in place and returns simulation statistics. */
export function simulate(particles: PhysicsParticle[], ctx: ForceContext): SimulationStats {
  if (particles.length === 0) {
    return {
      particleCount: 0,
      avgVelocityMagnitude: 0,
      maxVelocityMagnitude: 0,
      substepsRun: 0,
    };
  }

  const dim = particles[0].position.length;
  const diff = vecZero(dim);
  let accelerations: number[][] = particles.map(() => vecZero(dim));
  let next: number[][] = particles.map(() => vecZero(dim));
  computeAccelerations(particles, ctx, accelerations, diff);

  for (let step = 0; step < ctx.config.substeps; step++) {
    verletStep(particles, accelerations, next, ctx, diff);
    [accelerations, next] = [next, accelerations];
  }

  const now = new Date().toISOString();
  for (const p of particles) {
    p.lastSimulation = now;
  }

  let sumVelMag = 0;
  let maxVelMag = 0;
  for (const p of particles) {
    const mag = vecNorm(p.velocity);
    sumVelMag += mag;
    if (mag > maxVelMag) maxVelMag = mag;
  }

  return {
    particleCount: particles.length,
    avgVelocityMagnitude: sumVelMag / particles.length,
    maxVelocityMagnitude: maxVelMag,
    substepsRun: ctx.config.substeps,
  };
}

/** Kinetic plus pairwise potential energy; all pairs, so a caller reads it only on demand and under a particle cap. */
export function computeSystemEnergy(particles: PhysicsParticle[], gMemory: number): SystemEnergy {
  let kinetic = 0;
  let potential = 0;

  for (const p of particles) {
    const velMag = vecNorm(p.velocity);
    kinetic += 0.5 * p.mass * velMag * velMag;
  }

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const cos = cosineOf(particles[i].position, particles[j].position);
      potential -= gMemory * particles[i].mass * particles[j].mass * Math.max(0, cos);
    }
  }

  return { kinetic, potential, total: kinetic + potential };
}

/**
 * Scores all particles against a query embedding; virtual force computation, so it does NOT modify particle positions.
 */
export function physicsScore(
  particles: PhysicsParticle[],
  queryEmbedding: number[],
  config: PhysicsConfig,
  /**
   * Cross-ingest-stable tie key per memoryId (typically the memory content, from a caller with entries in scope);
   * without it ties fall to memoryId, which is per-instance only and lets the clusterTopK amplification set vary
   * across fresh ingests. */
  tieKeyOf?: (memoryId: string) => string,
): ScoredPhysicsResult[] {
  if (particles.length === 0 || queryEmbedding.length === 0) return [];

  const results: ScoredPhysicsResult[] = particles.map((p) => {
    const gravity = queryGravityMagnitude(p, queryEmbedding, config.gQuery);
    const momentum = config.momentumWeight * velocityAlignmentBonus(p, queryEmbedding);
    return {
      memoryId: p.memoryId,
      baseScore: gravity + momentum,
      clusterAmplification: 1.0,
      finalScore: gravity + momentum,
    };
  });

  // Base-score order picks the clusterTopK amplification SET (which mutates scores), so ties must be
  // cross-ingest-stable when the caller supplies a content tie key (see comparePhysicsResultsBy in compare.ts).
  const tie = tieKeyOf ? (r: ScoredPhysicsResult) => tieKeyOf(r.memoryId) : undefined;
  results.sort(comparePhysicsResultsBy((r) => r.baseScore, tie));

  applyClusterAmplification(results, particles, config);

  // Re-sort by final score, same tiebreak rule.
  results.sort(comparePhysicsResultsBy((r) => r.finalScore, tie));

  return results;
}

/** Cluster amplification: nearby high-scoring memories reinforce each other; mutates results in place. */
function applyClusterAmplification(
  results: ScoredPhysicsResult[],
  particles: PhysicsParticle[],
  config: PhysicsConfig,
): void {
  const topK = Math.min(config.clusterTopK, results.length);
  if (topK < 2) return;

  const particleMap = new Map<string, PhysicsParticle>();
  for (const p of particles) particleMap.set(p.memoryId, p);

  const top = results.slice(0, topK);

  for (let i = 0; i < top.length; i++) {
    const pi = particleMap.get(top[i].memoryId);
    if (!pi) continue;

    let clusterSignal = 0;
    for (let j = 0; j < top.length; j++) {
      if (i === j) continue;
      const pj = particleMap.get(top[j].memoryId);
      if (!pj) continue;

      const proximity = cosineOf(pi.position, pj.position);
      if (proximity > config.clusterThreshold) {
        clusterSignal += top[j].baseScore * proximity;
      }
    }

    const amplification = 1 + Math.tanh(clusterSignal * config.interferenceGain);
    top[i].clusterAmplification = amplification;
    top[i].finalScore = top[i].baseScore * amplification;
  }
}

/**
 * Initialize physics state for a memory from its embedding vector; returns the new particle without persisting (the
 * caller must save).
 */
export function initializeParticle(
  entry: MemoryEntry,
  embedding: number[],
  rules: StrengthOptions,
  now: Date = evalNow(),
): PhysicsParticle {
  const strength = calculateStrength(entry, now, rules);
  const ageDays = (now.getTime() - new Date(entry.created).getTime()) / DAY_MS;

  return {
    memoryId: entry.id,
    position: [...embedding], // copy: position will diverge from original embedding
    velocity: vecZero(embedding.length),
    mass: computeMass(strength, entry.retrievalCount, rules.ablation),
    charge: computeCharge(entry.emotionalValence),
    temperature: computeTemperature(ageDays, 1.0),
    lastSimulation: now.toISOString(),
  };
}
