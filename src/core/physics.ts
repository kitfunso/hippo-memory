/** Memory-as-Physics engine: pure math (forces, Velocity Verlet integration, physics-based scoring, cluster amplification), no I/O.
 * Memories are particles on the unit hypersphere in embedding space (384-dim); query gravity, attraction, conflict repulsion and drag act on them,
 * and nearby high-scoring memories amplify each other. */

import { isRecallBoostAblated } from './ablation.js';
import { FALLBACK_HALF_LIFE_DAYS, type EmotionalValence } from './memory.js';
import type { PhysicsConfig } from './physics-config.js';
import { comparePhysicsResultsBy } from './compare.js';

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

export function vecAdd(a: number[], b: number[]): number[] {
  const out = a.slice();
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

export function vecSub(a: number[], b: number[]): number[] {
  const out = a.slice();
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

export function vecZero(dim: number): number[] {
  return Array<number>(dim).fill(0);
}

/** Normalize to unit length. Returns zero vector if magnitude < epsilon. */
export function vecNormalize(v: number[]): number[] {
  const mag = vecNorm(v);
  if (mag < 1e-10) return vecZero(v.length);
  return vecScale(v, 1 / mag);
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
  if (na < 1e-10 || nb < 1e-10) return 0;
  return Math.min(1, Math.max(-1, dot / (na * nb)));
}

const CHARGE_MAP = {
  neutral: 0,
  positive: 0.3,
  negative: -0.5,
  critical: -1.0,
} satisfies Record<EmotionalValence, number>;

export function computeMass(strength: number, retrievalCount: number): number {
  // EVAL-ONLY ablation (ablation.ts): under the recall-boost flag mass ignores retrieval history, which would otherwise leak strengthening into the ablated
  // arm's physics-pool rankings (query gravity ranks by mass). Covers both init and refresh callers in physics-state.ts.
  const effectiveCount = isRecallBoostAblated() ? 0 : retrievalCount;
  return Math.max(0.01, strength * (1 + 0.1 * Math.log2(effectiveCount + 1)));
}

export function computeCharge(valence: EmotionalValence): number {
  return CHARGE_MAP[valence] ?? 0;
}

export function computeTemperature(ageDays: number, temperatureDecay: number): number {
  return 1 / (ageDays * temperatureDecay + 1);
}

/** Query gravity (retrieval-time, virtual: does not move the particle): scalar ranking magnitude F = G_Q * mass * max(0, cosine(pos, query))^2. */
export function queryGravityMagnitude(
  particle: PhysicsParticle,
  queryEmbedding: number[],
  G_query: number,
): number {
  const cos = cosine(particle.position, queryEmbedding);
  return G_query * particle.mass * Math.pow(Math.max(0, cos), 2);
}

/** Momentum bonus in [0, 1]: how aligned the particle's velocity is with the query direction. */
export function velocityAlignmentBonus(
  particle: PhysicsParticle,
  queryEmbedding: number[],
): number {
  if (particle.velocity.length === 0 || particle.velocity.length !== queryEmbedding.length) return 0;
  const velMag = vecNorm(particle.velocity);
  const qNorm = vecNorm(queryEmbedding);
  if (velMag < 1e-10 || qNorm < 1e-10) return 0;
  const alignment = vecDot(particle.velocity, queryEmbedding) / (velMag * qNorm);
  return Math.max(0, alignment);
}

/** Attraction force on particle i from j (consolidation-time): G_M m_i m_j max(0, cosine)^3, directed along (pos_j - pos_i) projected tangent to the unit
 * sphere at pos_i (positions are re-normalized to the sphere after integration). */
export function attractionForce(
  pi: PhysicsParticle,
  pj: PhysicsParticle,
  G_memory: number,
): number[] {
  const cos = cosine(pi.position, pj.position);
  if (cos <= 0) return vecZero(pi.position.length);

  const magnitude = G_memory * pi.mass * pj.mass * Math.pow(cos, 3);
  // Direction: from i toward j (tangent projection handled by normalization after integration)
  const direction = vecNormalize(vecSub(pj.position, pi.position));
  return vecScale(direction, magnitude);
}

/** Conflict repulsion on i away from j (consolidation-time): K_R * m_i * m_j / max(0.01, cosine_distance)^2, where cosine_distance = 1 - cosine_similarity. */
export function repulsionForce(
  pi: PhysicsParticle,
  pj: PhysicsParticle,
  K_repulsion: number,
): number[] {
  const cos = cosine(pi.position, pj.position);
  const dist = Math.max(0.01, 1 - cos);
  const magnitude = K_repulsion * pi.mass * pj.mass / (dist * dist);
  // Direction: away from j
  const direction = vecNormalize(vecSub(pi.position, pj.position));
  return vecScale(direction, magnitude);
}

/** Drag force (consolidation-time): -drag * velocity / max(1, effectiveHalfLife), with effectiveHalfLife from the memory's current half_life_days. */
export function dragForce(
  particle: PhysicsParticle,
  drag: number,
  effectiveHalfLife: number,
): number[] {
  const damping = drag / Math.max(1, effectiveHalfLife);
  return vecScale(particle.velocity, -damping);
}

export interface ForceContext {
  /** Map of memory ID -> list of conflicting memory IDs */
  conflictPairs: Map<string, Set<string>>;
  /** Map of memory ID -> effective half-life days */
  halfLives: Map<string, number>;
  config: PhysicsConfig;
}

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
  const fd = dragForce(pi, ctx.config.drag, ctx.halfLives.get(pi.memoryId) ?? FALLBACK_HALF_LIFE_DAYS);
  net = vecAdd(net, fd);

  return net;
}

/** One Velocity Verlet step for all particles; mutates in place for performance. */
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
  }

  // Update accelerations for next step
  for (let i = 0; i < accelerations.length; i++) {
    accelerations[i] = newAccelerations[i];
  }
}

/** Full physics simulation for one sleep cycle; mutates particles in place and returns simulation statistics. */
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

/** Scores all particles against a query embedding; virtual force computation, so it does NOT modify particle positions. */
export function physicsScore(
  particles: PhysicsParticle[],
  queryEmbedding: number[],
  config: PhysicsConfig,
  /** Cross-ingest-stable tie key per memoryId (typically the memory content, from a caller with entries in scope); without it ties fall to memoryId,
   *  which is per-instance only and lets the cluster_top_k amplification set vary across fresh ingests. */
  tieKeyOf?: (memoryId: string) => string,
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

  // Base-score order picks the cluster_top_k amplification SET (which mutates scores), so ties must be cross-ingest-stable
  // when the caller supplies a content tie key (see comparePhysicsResultsBy in compare.ts).
  const tie = tieKeyOf ? (r: ScoredPhysicsResult) => tieKeyOf(r.memoryId) : undefined;
  results.sort(comparePhysicsResultsBy((r) => r.baseScore, tie));

  // Pass 2: cluster amplification on top K
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

/** Nudges a particle toward (good outcome) or away from (bad outcome) the query embedding; new memories respond more (temperature). Mutates in place. */
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
