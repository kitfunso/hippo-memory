// simulate() accumulates forces in place; this keeps the allocating implementation it replaced and holds the two together.
import { describe, expect, it } from 'vitest';
import {
  attractionForce, repulsionForce, dragForce, simulate, vecAdd, vecScale, vecNormalize, vecClampMagnitude, vecZero,
  type ForceContext, type PhysicsParticle,
} from '../src/core/physics.js';
import { DEFAULT_PHYSICS_CONFIG } from '../src/core/physics-config.js';
import { FALLBACK_HALF_LIFE_DAYS } from '../src/core/memory.js';

function netForce(i: number, particles: PhysicsParticle[], ctx: ForceContext): number[] {
  const pi = particles[i];
  let net = vecZero(pi.position.length);
  const conflicts = ctx.conflictPairs.get(pi.memoryId);
  for (let j = 0; j < particles.length; j++) {
    if (i === j) continue;
    net = vecAdd(net, attractionForce(pi, particles[j], ctx.config.G_memory));
    if (conflicts?.has(particles[j].memoryId)) net = vecAdd(net, repulsionForce(pi, particles[j], ctx.config.K_repulsion));
  }
  return vecAdd(net, dragForce(pi, ctx.config.drag, ctx.halfLives.get(pi.memoryId) ?? FALLBACK_HALF_LIFE_DAYS));
}

const accelOf = (i: number, ps: PhysicsParticle[], ctx: ForceContext): number[] => vecScale(netForce(i, ps, ctx), 1 / Math.max(0.01, ps[i].mass));

function simulateAllocating(particles: PhysicsParticle[], ctx: ForceContext): void {
  const { dt, max_velocity: maxVel } = ctx.config;
  let accelerations = particles.map((_, i) => accelOf(i, particles, ctx));
  for (let step = 0; step < ctx.config.substeps; step++) {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.position = vecAdd(vecAdd(p.position, vecScale(p.velocity, dt)), vecScale(accelerations[i], 0.5 * dt * dt));
    }
    const next = particles.map((_, i) => accelOf(i, particles, ctx));
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.velocity = vecClampMagnitude(vecAdd(p.velocity, vecScale(vecScale(vecAdd(accelerations[i], next[i]), 0.5), dt)), maxVel);
      p.position = vecNormalize(p.position);
    }
    accelerations = next;
  }
}

/** A seeded linear congruential generator, so the fixture is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

interface Fixture {
  particles: PhysicsParticle[];
  ctx: ForceContext;
}

function fixture(): Fixture {
  const rand = seeded(42);
  const particles: PhysicsParticle[] = Array.from({ length: 12 }, (_, i) => ({
    memoryId: `m${i}`,
    position: vecNormalize(Array.from({ length: 8 }, rand)),
    velocity: Array.from({ length: 8 }, () => rand() * 0.1),
    mass: 0.5 + Math.abs(rand()) * 3,
    charge: 0,
    temperature: 1,
    lastSimulation: '2026-01-01T00:00:00.000Z',
  }));
  // m11 equals m10 so the zero-distance direction branch runs; m3 and m4 sit opposite so a negative cosine runs.
  particles[11].position = particles[10].position.slice();
  particles[4].position = particles[3].position.map((v) => -v);
  const ctx: ForceContext = {
    conflictPairs: new Map([['m0', new Set(['m1', 'm2'])], ['m1', new Set(['m0'])], ['m5', new Set(['m6'])], ['m10', new Set(['m11'])]]),
    halfLives: new Map([['m0', 3], ['m7', 90]]),
    config: { ...DEFAULT_PHYSICS_CONFIG, substeps: 5 },
  };
  return { particles, ctx };
}

describe('simulate', () => {
  it('matches the allocating implementation to 1e-12', () => {
    const a = fixture();
    const b = fixture();
    simulate(a.particles, a.ctx);
    simulateAllocating(b.particles, b.ctx);
    for (let i = 0; i < a.particles.length; i++) {
      for (let k = 0; k < 8; k++) {
        expect(Math.abs(a.particles[i].position[k] - b.particles[i].position[k])).toBeLessThan(1e-12);
        expect(Math.abs(a.particles[i].velocity[k] - b.particles[i].velocity[k])).toBeLessThan(1e-12);
      }
    }
  });
});
