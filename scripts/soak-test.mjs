#!/usr/bin/env node
/**
 * O1 — Physics engine soak test harness.
 *
 * Runs the hippo physics engine continuously under one of 10 workload profiles
 * and logs energy + velocity trajectories. Used to validate convergence claims
 * in the Frontier AI Discovery feasibility study: "bounded energy across all 10
 * workload profiles."
 *
 * Usage:
 *   node scripts/soak-test.mjs --profile balanced --ticks 100 --out results/soak-balanced.csv
 *   node scripts/soak-test.mjs --profile write-heavy --hours 24 --out results/soak-24h.csv
 *
 * A "tick" is one physics-simulate cycle. At default config, ~5 substeps of
 * Velocity Verlet integration. Real-time cost: milliseconds per tick.
 *
 * Profiles exercise distinct failure modes; if any diverge, the engine has a
 * stability bug we'd need to fix before the grant period.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  simulate,
  computeSystemEnergy,
  vecDot,
  vecNormalize,
} from '../dist/physics.js';
import { DEFAULT_PHYSICS_CONFIG, mergePhysicsConfig } from '../dist/physics-config.js';

// ---- flags ----

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && !v.includes(',') ? n : v;
}

const PROFILE = String(flag('--profile', 'balanced'));
const TICKS = Number(flag('--ticks', 100));
const SEED = Number(flag('--seed', 42));
const DIM = Number(flag('--dim', 384));
const OUT = String(flag('--out', `benchmarks/soak/results/soak-${PROFILE}.csv`));
const STARTING_PARTICLES = Number(flag('--particles', 100));
const VERBOSE = process.argv.includes('--verbose');

// ---- deterministic RNG ----

class Mulberry32 {
  constructor(seed) { this.s = seed >>> 0; }
  next() {
    let t = (this.s += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss() {
    // Box–Muller
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  int(a, b) { return a + Math.floor(this.next() * (b - a)); }
}

const rng = new Mulberry32(SEED);

function randomUnitVec(dim) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rng.gauss();
  return vecNormalize(v);
}

function randomNearbyVec(base, scatter, dim) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = base[i] + scatter * rng.gauss();
  return vecNormalize(v);
}

// ---- particle factory ----

function makeParticle(id, position, opts = {}) {
  return {
    memoryId: id,
    position,
    velocity: new Array(position.length).fill(0),
    mass: opts.mass ?? 1.0,
    charge: opts.charge ?? 0.0, // +1 = positive valence, -1 = negative, 0 = neutral
    temperature: opts.temperature ?? 1.0,
    lastSimulation: new Date().toISOString(),
  };
}

// ---- workload profiles ----
//
// Each profile returns a function `applyTick(state, tickIdx)` that mutates
// the particle list + conflicts map to reflect what a given workload does
// between simulation cycles.

const PROFILES = {
  /** Balanced: mild churn, some adds, some removes, occasional conflict. */
  balanced(state) {
    state.particles.push(makeParticle(`p${state.nextId++}`, randomUnitVec(DIM)));
    if (rng.next() < 0.3 && state.particles.length > 50) {
      state.particles.splice(rng.int(0, state.particles.length), 1);
    }
    if (rng.next() < 0.1 && state.particles.length >= 2) {
      addConflict(state, randomPair(state));
    }
  },

  /** Write-heavy: add 2 new particles per tick, rarely remove. Caps growth via LRU-ish pruning. */
  'write-heavy'(state) {
    for (let k = 0; k < 2; k++) {
      state.particles.push(makeParticle(`p${state.nextId++}`, randomUnitVec(DIM)));
    }
    // Soft cap at 500 to keep O(N^2) physics bounded in soak test
    while (state.particles.length > 500) {
      state.particles.splice(0, 1);
    }
  },

  /** Read-heavy: no adds, simulate retrieval-strengthening via mass bumps. */
  'read-heavy'(state) {
    for (let k = 0; k < 10; k++) {
      if (state.particles.length === 0) break;
      const p = state.particles[rng.int(0, state.particles.length)];
      p.mass = Math.min(10, p.mass * 1.02);
    }
  },

  /** Burst: periods of silence punctuated by large add bursts. */
  burst(state, tick) {
    if (tick % 20 === 0) {
      for (let k = 0; k < 20; k++) {
        state.particles.push(makeParticle(`p${state.nextId++}`, randomUnitVec(DIM)));
      }
    }
  },

  /** Dedup-heavy: many near-duplicate particles around a small number of centers. */
  'dedup-heavy'(state) {
    if (state.centers.length === 0) {
      for (let k = 0; k < 5; k++) state.centers.push(randomUnitVec(DIM));
    }
    const center = state.centers[rng.int(0, state.centers.length)];
    state.particles.push(makeParticle(`p${state.nextId++}`, randomNearbyVec(center, 0.05, DIM)));
  },

  /** Conflict-heavy: 25% of new additions spawn a conflict with a random peer. */
  'conflict-heavy'(state) {
    const p = makeParticle(`p${state.nextId++}`, randomUnitVec(DIM), { charge: -1 });
    state.particles.push(p);
    if (state.particles.length >= 2 && rng.next() < 0.25) {
      const other = state.particles[rng.int(0, state.particles.length - 1)];
      addConflict(state, [p.memoryId, other.memoryId]);
    }
  },

  /** Decay-only: no new writes — does the existing population settle? */
  'decay-only'(state) {
    // No-op; rely on initial population.
    void state;
  },

  /** Reward-modulated: flip a random charge each tick, simulating outcome feedback. */
  'reward-modulated'(state) {
    if (state.particles.length === 0) return;
    const p = state.particles[rng.int(0, state.particles.length)];
    p.charge = rng.next() < 0.5 ? 1 : -1;
    p.mass *= rng.next() < 0.5 ? 1.05 : 0.95;
  },

  /** Consolidation-heavy: long gaps, then big merges (represented as pruning). */
  'consolidation-heavy'(state, tick) {
    if (tick % 10 < 8) return; // idle for 8 of every 10 ticks
    // Prune half the population (simulate merging)
    const keep = Math.floor(state.particles.length / 2);
    state.particles = state.particles.slice(0, keep);
  },

  /** Steady-state: constant add+remove to keep N roughly fixed. */
  'steady-state'(state) {
    state.particles.push(makeParticle(`p${state.nextId++}`, randomUnitVec(DIM)));
    if (state.particles.length > STARTING_PARTICLES) {
      state.particles.splice(rng.int(0, state.particles.length), 1);
    }
  },
};

function addConflict(state, pair) {
  const [a, b] = pair;
  if (!state.conflicts.has(a)) state.conflicts.set(a, new Set());
  if (!state.conflicts.has(b)) state.conflicts.set(b, new Set());
  state.conflicts.get(a).add(b);
  state.conflicts.get(b).add(a);
}

function randomPair(state) {
  const a = state.particles[rng.int(0, state.particles.length)];
  let b = state.particles[rng.int(0, state.particles.length)];
  let tries = 0;
  while (b.memoryId === a.memoryId && tries++ < 5) {
    b = state.particles[rng.int(0, state.particles.length)];
  }
  return [a.memoryId, b.memoryId];
}

// ---- main loop ----

function initState() {
  const state = {
    particles: [],
    conflicts: new Map(),
    halfLives: new Map(),
    nextId: 0,
    centers: [],
  };
  for (let i = 0; i < STARTING_PARTICLES; i++) {
    const p = makeParticle(`p${state.nextId++}`, randomUnitVec(DIM));
    state.particles.push(p);
    state.halfLives.set(p.memoryId, 7);
  }
  return state;
}

function run() {
  if (!PROFILES[PROFILE]) {
    console.error(`Unknown profile: ${PROFILE}. Available: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }

  const state = initState();
  const config = mergePhysicsConfig();
  const ctx = {
    conflictPairs: state.conflicts,
    halfLives: state.halfLives,
    config,
  };

  const rows = [];
  const header = ['tick', 'wall_ms', 'particles', 'kinetic', 'potential', 'total_energy', 'avg_vel', 'max_vel', 'substeps'];

  console.error(`Soak test: profile=${PROFILE}, ticks=${TICKS}, start=${STARTING_PARTICLES} particles, dim=${DIM}, seed=${SEED}`);
  const started = Date.now();

  // Record t=0 state before any simulation
  {
    const e = computeSystemEnergy(state.particles, config.G_memory);
    rows.push([0, 0, state.particles.length, e.kinetic, e.potential, e.total, 0, 0, 0]);
  }

  for (let tick = 1; tick <= TICKS; tick++) {
    // Apply workload mutation
    PROFILES[PROFILE](state, tick);

    // Keep halfLives entries in sync with particles
    for (const p of state.particles) {
      if (!state.halfLives.has(p.memoryId)) state.halfLives.set(p.memoryId, 7);
    }

    // Advance physics
    const t0 = Date.now();
    const stats = simulate(state.particles, ctx);
    const tickMs = Date.now() - t0;

    rows.push([
      tick,
      Date.now() - started,
      stats.particleCount,
      stats.energy.kinetic.toFixed(6),
      stats.energy.potential.toFixed(6),
      stats.energy.total.toFixed(6),
      stats.avgVelocityMagnitude.toFixed(6),
      stats.maxVelocityMagnitude.toFixed(6),
      stats.substepsRun,
    ]);

    if (VERBOSE || tick % Math.max(1, Math.floor(TICKS / 20)) === 0) {
      console.error(`  tick ${tick}/${TICKS}: n=${stats.particleCount}, E=${stats.energy.total.toFixed(3)} (K ${stats.energy.kinetic.toFixed(3)}, P ${stats.energy.potential.toFixed(3)}), |v|_max=${stats.maxVelocityMagnitude.toFixed(4)} [${tickMs}ms]`);
    }

    // Detect divergence early
    if (!Number.isFinite(stats.energy.total)) {
      console.error(`  DIVERGENCE at tick ${tick}: non-finite energy`);
      break;
    }
    if (stats.maxVelocityMagnitude > 10 * config.max_velocity) {
      console.error(`  RUNAWAY at tick ${tick}: |v|_max=${stats.maxVelocityMagnitude} exceeds 10x cap`);
      break;
    }
  }

  // ---- write CSV ----
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  fs.writeFileSync(OUT, csv);

  // ---- summary ----
  const lastRow = rows[rows.length - 1];
  const totalEnergy = Number(lastRow[5]);
  const firstEnergy = Number(rows[1]?.[5] ?? rows[0][5]);
  const maxEnergyAbs = Math.max(...rows.slice(1).map(r => Math.abs(Number(r[5]))));
  const maxVel = Math.max(...rows.slice(1).map(r => Number(r[7])));
  console.error('\n=== Summary ===');
  console.error(`  profile:         ${PROFILE}`);
  console.error(`  ticks completed: ${rows.length - 1} / ${TICKS}`);
  console.error(`  wall time:       ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.error(`  final particles: ${lastRow[2]}`);
  console.error(`  first energy:    ${firstEnergy.toFixed(4)}`);
  console.error(`  final energy:    ${totalEnergy.toFixed(4)}`);
  console.error(`  |max energy|:    ${maxEnergyAbs.toFixed(4)}`);
  console.error(`  max |velocity|:  ${maxVel.toFixed(4)} (config cap: ${config.max_velocity})`);
  console.error(`  bounded:         ${Number.isFinite(totalEnergy) && maxVel <= config.max_velocity * 10 ? 'YES' : 'NO'}`);
  console.error(`  CSV written to:  ${OUT}`);
}

run();
