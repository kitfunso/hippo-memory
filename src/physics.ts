/**
 * Memory-as-Physics engine for Hippo.
 *
 * Pure math module: forces, Velocity Verlet integration, physics-based scoring,
 * and cluster amplification. No I/O — all state is passed in and returned.
 *
 * Memories are particles on the unit hypersphere in embedding space (384-dim).
 * Forces act on them: query gravity (retrieval), inter-memory attraction,
 * conflict repulsion, and drag (consolidation). Nearby high-scoring memories
 * amplify each other via constructive interference.
 */

import type { EmotionalValence } from './memory.js';
import type { PhysicsConfig } from './physics-config.js';

/** Shared epsilon for zero-magnitude checks (normalization, co-location, cosine). */
const EPSILON = 1e-10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhysicsParticle {
  memoryId: string;
  position: number[];    // 384-dim, unit-normalized
  velocity: number[];    // 384-dim
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
  energy: SystemEnergy;
  substepsRun: number;
}

// ---------------------------------------------------------------------------
// Vector math (hot path — kept inline for performance)
// ---------------------------------------------------------------------------

export function vecDot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function vecNorm(v: number[]): number {
  return Math.sqrt(vecDot(v, v));
}

export function vecScale(v: number[], s: number): number[] {
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * s;
  return out;
}

export function vecAdd(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

export function vecSub(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

export function vecZero(dim: number): number[] {
  return new Array<number>(dim).fill(0);
}

/** Normalize to unit length. Returns zero vector if magnitude < EPSILON. */
export function vecNormalize(v: number[]): number[] {
  const mag = vecNorm(v);
  if (mag < EPSILON) return vecZero(v.length);
  return vecScale(v, 1 / mag);
}

/** Random unit vector — fallback for degenerate co-location cases. */
function randomUnitVector(dims: number): number[] {
  const v = Array.from({ length: dims }, () => Math.random() - 0.5);
  // Fallback if all components are ~0 (astronomically unlikely)
  if (vecNorm(v) < EPSILON) v[0] = 1;
  return vecNormalize(v);
}

/** Clamp vector magnitude to maxMag. */
export function vecClampMagnitude(v: number[], maxMag: number): number[] {
  const mag = vecNorm(v);
  if (mag <= maxMag) return v;
  return vecScale(v, maxMag / mag);
}

/** Cosine similarity between two vectors. */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  const dot = vecDot(a, b);
  const na = vecNorm(a);
  const nb = vecNorm(b);
  if (na < EPSILON || nb < EPSILON) return 0;
  return Math.min(1, Math.max(-1, dot / (na * nb)));
}

// ---------------------------------------------------------------------------
// Property derivation from memory attributes
// ---------------------------------------------------------------------------

const CHARGE_MAP: Record<EmotionalValence, number> = {
  neutral: 0,
  positive: 0.3,
  negative: -0.5,
  critical: -1.0,
};

export function computeMass(strength: number, retrievalCount: number): number {
  return Math.max(0.01, strength * (1 + 0.1 * Math.log2(retrievalCount + 1)));
}

export function computeCharge(valence: EmotionalValence): number {
  return CHARGE_MAP[valence] ?? 0;
}

export function computeTemperature(ageDays: number, temperatureDecay: number): number {
  return 1 / (ageDays * temperatureDecay + 1);
}

// ---------------------------------------------------------------------------
// Force computations
// ---------------------------------------------------------------------------

/**
 * F1: Query gravity (retrieval-time, virtual — does not update position).
 * Returns scalar force magnitude for ranking.
 *
 * F_query(i) = G_Q * mass(i) * max(0, cosine(pos_i, query))^2
 */
export function queryGravityMagnitude(
  particle: PhysicsParticle,
  queryEmbedding: number[],
  G_query: number,
): number {
  const cos = cosine(particle.position, queryEmbedding);
  return G_query * particle.mass * Math.pow(Math.max(0, cos), 2);
}

/**
 * Momentum bonus: how aligned is the particle's velocity with the query direction?
 * Returns a value in [0, 1].
 */
export function velocityAlignmentBonus(
  particle: PhysicsParticle,
  queryEmbedding: number[],
): number {
  if (particle.velocity.length === 0 || particle.velocity.length !== queryEmbedding.length) return 0;
  const velMag = vecNorm(particle.velocity);
  const qNorm = vecNorm(queryEmbedding);
  if (velMag < EPSILON || qNorm < EPSILON) return 0;
  const alignment = vecDot(particle.velocity, queryEmbedding) / (velMag * qNorm);
  return Math.max(0, alignment);
}

/**
 * F2: Inter-memory attraction force vector (consolidation-time).
 * Attractive force from particle j on particle i.
 *
 * F_attract(i,j) = G_M * m_i * m_j * max(0, cosine(i,j))^3 * direction(j→i in embedding space)
 *
 * Direction is computed as the component of (pos_j - pos_i) that lies tangent to the
 * unit sphere at pos_i (since we normalize positions back to the sphere after integration).
 */
export function attractionForce(
  pi: PhysicsParticle,
  pj: PhysicsParticle,
  G_memory: number,
): number[] {
  const cos = cosine(pi.position, pj.position);
  if (cos <= 0) return vecZero(pi.position.length);

  const magnitude = G_memory * pi.mass * pj.mass * Math.pow(cos, 3);
  // Direction: from i toward j (tangent projection handled by normalization after integration)
  let direction = vecNormalize(vecSub(pj.position, pi.position));
  if (vecNorm(direction) < EPSILON) {
    direction = randomUnitVector(pi.position.length);
  }
  return vecScale(direction, magnitude);
}

/**
 * F3: Conflict repulsion force vector (consolidation-time).
 * Repulsive force pushing i away from j.
 *
 * F_repel(i,j) = K_R * m_i * m_j / max(0.01, cosine_distance(i,j))^2
 * where cosine_distance = 1 - cosine_similarity
 */
export function repulsionForce(
  pi: PhysicsParticle,
  pj: PhysicsParticle,
  K_repulsion: number,
): number[] {
  const cos = cosine(pi.position, pj.position);
  const dist = Math.max(0.01, 1 - cos);
  const magnitude = K_repulsion * pi.mass * pj.mass / (dist * dist);
  // Direction: away from j
  let direction = vecNormalize(vecSub(pi.position, pj.position));
  if (vecNorm(direction) < EPSILON) {
    direction = randomUnitVector(pi.position.length);
  }
  return vecScale(direction, magnitude);
}

/**
 * F4: Drag force vector (consolidation-time).
 * F_drag(i) = -drag * velocity(i) / max(1, effective_half_life(i))
 *
 * effectiveHalfLife should be passed in from the memory's current half_life_days.
 */
export function dragForce(
  particle: PhysicsParticle,
  drag: number,
  effectiveHalfLife: number,
): number[] {
  const damping = drag / Math.max(1, effectiveHalfLife);
  return vecScale(particle.velocity, -damping);
}

// ---------------------------------------------------------------------------
// Velocity Verlet integration
// ---------------------------------------------------------------------------

export interface ForceContext {
  /** Map of memory ID -> list of conflicting memory IDs */
  conflictPairs: Map<string, Set<string>>;
  /** Map of memory ID -> effective half-life days */
  halfLives: Map<string, number>;
  config: PhysicsConfig;
}

/**
 * Compute net force on particle i from all other particles + drag.
 */
function computeNetForce(
  i: number,
  particles: PhysicsParticle[],
  ctx: ForceContext,
): number[] {
  const pi = particles[i];
  const dim = pi.position.length;
  let net = vecZero(dim);

  const conflicts = ctx.conflictPairs.get(pi.memoryId);

  for (let j = 0; j < particles.length; j++) {
    if (i === j) continue;
    const pj = particles[j];

    // Attraction (all pairs)
    const fa = attractionForce(pi, pj, ctx.config.G_memory);
    net = vecAdd(net, fa);

    // Repulsion (conflict pairs only)
    if (conflicts?.has(pj.memoryId)) {
      const fr = repulsionForce(pi, pj, ctx.config.K_repulsion);
      net = vecAdd(net, fr);
    }
  }

  // Drag
  const fd = dragForce(pi, ctx.config.drag, ctx.halfLives.get(pi.memoryId) ?? 7);
  net = vecAdd(net, fd);

  return net;
}

/**
 * Run one Velocity Verlet integration step for all particles.
 * Mutates particles in place for performance.
 */
function verletStep(
  particles: PhysicsParticle[],
  accelerations: number[][],
  ctx: ForceContext,
): void {
  const dt = ctx.config.dt;
  const maxVel = ctx.config.max_velocity;

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];

    // Position update: pos += vel*dt + 0.5*accel*dt^2
    const velDt = vecScale(p.velocity, dt);
    const accelDt2 = vecScale(accelerations[i], 0.5 * dt * dt);
    p.position = vecAdd(vecAdd(p.position, velDt), accelDt2);
  }

  // Compute new accelerations
  const newAccelerations: number[][] = [];
  for (let i = 0; i < particles.length; i++) {
    const force = computeNetForce(i, particles, ctx);
    newAccelerations.push(vecScale(force, 1 / Math.max(0.01, particles[i].mass)));
  }

  // Velocity update: vel += 0.5*(accel_old + accel_new)*dt
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const avgAccel = vecScale(vecAdd(accelerations[i], newAccelerations[i]), 0.5);
    p.velocity = vecAdd(p.velocity, vecScale(avgAccel, dt));

    // Stability: clamp velocity and normalize position to unit sphere
    p.velocity = vecClampMagnitude(p.velocity, maxVel);
    p.position = vecNormalize(p.position);
    if (vecNorm(p.position) < EPSILON) {
      p.position = randomUnitVector(p.position.length);
    }
  }

  // Update accelerations for next step
  for (let i = 0; i < accelerations.length; i++) {
    accelerations[i] = newAccelerations[i];
  }
}

/**
 * Run the full physics simulation for one sleep cycle.
 * Mutates particles in place. Returns simulation statistics.
 */
export function simulate(
  particles: PhysicsParticle[],
  ctx: ForceContext,
): SimulationStats {
  if (particles.length === 0) {
    return {
      particleCount: 0,
      avgVelocityMagnitude: 0,
      maxVelocityMagnitude: 0,
      energy: { kinetic: 0, potential: 0, total: 0 },
      substepsRun: 0,
    };
  }

  // Initial accelerations
  const accelerations: number[][] = particles.map((_, i) => {
    const force = computeNetForce(i, particles, ctx);
    return vecScale(force, 1 / Math.max(0.01, particles[i].mass));
  });

  // Run substeps
  for (let step = 0; step < ctx.config.substeps; step++) {
    verletStep(particles, accelerations, ctx);
  }

  // Update timestamps
  const now = new Date().toISOString();
  for (const p of particles) {
    p.lastSimulation = now;
  }

  // Compute stats
  let sumVelMag = 0;
  let maxVelMag = 0;
  for (const p of particles) {
    const mag = vecNorm(p.velocity);
    sumVelMag += mag;
    if (mag > maxVelMag) maxVelMag = mag;
  }

  const energy = computeSystemEnergy(particles, ctx.config.G_memory);

  return {
    particleCount: particles.length,
    avgVelocityMagnitude: sumVelMag / particles.length,
    maxVelocityMagnitude: maxVelMag,
    energy,
    substepsRun: ctx.config.substeps,
  };
}

// ---------------------------------------------------------------------------
// System energy (health monitoring)
// ---------------------------------------------------------------------------

export function computeSystemEnergy(
  particles: PhysicsParticle[],
  G_memory: number,
): SystemEnergy {
  let kinetic = 0;
  let potential = 0;

  for (const p of particles) {
    const velMag = vecNorm(p.velocity);
    kinetic += 0.5 * p.mass * velMag * velMag;
  }

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const cos = cosine(particles[i].position, particles[j].position);
      potential -= G_memory * particles[i].mass * particles[j].mass * Math.max(0, cos);
    }
  }

  return { kinetic, potential, total: kinetic + potential };
}

// ---------------------------------------------------------------------------
// Physics-based scoring (retrieval-time)
// ---------------------------------------------------------------------------

/**
 * Score all particles against a query embedding using physics-based ranking.
 * Does NOT modify particle positions (virtual force computation).
 */
export function physicsScore(
  particles: PhysicsParticle[],
  queryEmbedding: number[],
  config: PhysicsConfig,
): ScoredPhysicsResult[] {
  if (particles.length === 0 || queryEmbedding.length === 0) return [];

  // Pass 1: compute base scores
  const results: ScoredPhysicsResult[] = particles.map((p) => {
    const gravity = queryGravityMagnitude(p, queryEmbedding, config.G_query);
    const momentum = config.momentum_weight * velocityAlignmentBonus(p, queryEmbedding);
    return {
      memoryId: p.memoryId,
      baseScore: gravity + momentum,
      clusterAmplification: 1.0,
      finalScore: gravity + momentum,
    };
  });

  // Sort by base score for top-K selection
  results.sort((a, b) => b.baseScore - a.baseScore);

  // Pass 2: cluster amplification on top K
  applyClusterAmplification(results, particles, config);

  // Re-sort by final score
  results.sort((a, b) => b.finalScore - a.finalScore);

  return results;
}

/**
 * Cluster amplification: nearby high-scoring memories reinforce each other.
 * Mutates results in place.
 */
function applyClusterAmplification(
  results: ScoredPhysicsResult[],
  particles: PhysicsParticle[],
  config: PhysicsConfig,
): void {
  const topK = Math.min(config.cluster_top_k, results.length);
  if (topK < 2) return;

  // Build a quick lookup from memoryId to particle
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

      const proximity = cosine(pi.position, pj.position);
      if (proximity > config.cluster_threshold) {
        clusterSignal += top[j].baseScore * proximity;
      }
    }

    const amplification = 1 + Math.tanh(clusterSignal * config.interference_gain);
    top[i].clusterAmplification = amplification;
    top[i].finalScore = top[i].baseScore * amplification;
  }
}

// ---------------------------------------------------------------------------
// Outcome feedback (micro-nudge)
// ---------------------------------------------------------------------------

/**
 * Nudge a particle's position toward (good outcome) or away from (bad outcome)
 * the query embedding. Respects temperature: new memories respond more.
 * Mutates particle in place.
 */
export function applyOutcomeFeedback(
  particle: PhysicsParticle,
  queryEmbedding: number[],
  good: boolean,
  feedbackAlpha: number,
): void {
  if (particle.position.length === 0 || particle.position.length !== queryEmbedding.length) return;
  const sign = good ? 1 : -1;
  const direction = vecSub(queryEmbedding, particle.position);
  const nudge = vecScale(direction, sign * feedbackAlpha * particle.temperature);
  particle.position = vecNormalize(vecAdd(particle.position, nudge));
}
