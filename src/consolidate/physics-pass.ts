import { refreshParticleProperties } from '../core/particle-refresh.js';
import { simulate, type ForceContext, type PhysicsParticle } from '../core/physics.js';
import type { MemoryEntry } from '../core/memory.js';
import type { SleepRun } from './run.js';
import { errorMessage } from '../util/log.js';

const STATS_DECIMALS = 4;
// Every substep is all-pairs, so one sleep moves at most this many particles; the rest keep their stored state until
// they are recalled.
const SLEEP_PHYSICS_MAX_PARTICLES = 1000;

// 2. Physics simulation pass
export function physicsPass(run: SleepRun, maxParticles: number = SLEEP_PHYSICS_MAX_PARTICLES): void {
  if (run.dryRun) return;
  const { config, result } = run;
  try {
    const physicsEnabled = config.physics.enabled === true
      || (config.physics.enabled === 'auto');

    if (physicsEnabled) simulateStoredParticles(run, maxParticles);
  } catch (error) {
    result.details.push(`  ⚠️ physics simulation skipped: ${errorMessage(error)}`);
  }
}

function simulateStoredParticles(run: SleepRun, maxParticles: number): void {
  const { result, survivors } = run;
  const stored = run.store.storedParticles();
  if (stored.length === 0) return;

  // Build entry lookup for property refresh
  const entryMap = new Map(survivors.map(e => [e.id, e]));
  const particles = particlesToSimulate(stored, entryMap, maxParticles);
  refreshParticleProperties(particles, entryMap, run.now);

  const stats = simulate(particles, survivorForces(run));
  run.store.saveParticles(particles);

  result.physicsSimulated = stats.particleCount;
  const capped =
    particles.length < stored.length ? ` (the ${particles.length} most recently recalled of ${stored.length})` : '';
  result.details.push(
    `  ⚛️  physics: ${stats.particleCount} particles${capped}, ` +
    `avg vel ${stats.avgVelocityMagnitude.toFixed(STATS_DECIMALS)}, ` +
    `energy ${stats.energy.total.toFixed(STATS_DECIMALS)}`
  );
}

/**
 * Every stored particle in load order up to the cap; past it, the most recently recalled survivors (memory id breaks
 * ties),
 * then particles with no survivor. */
export function particlesToSimulate(
  stored: PhysicsParticle[],
  entries: ReadonlyMap<string, MemoryEntry>,
  max: number = SLEEP_PHYSICS_MAX_PARTICLES,
): PhysicsParticle[] {
  if (stored.length <= max) return stored;
  const recalled = (p: PhysicsParticle): string => entries.get(p.memoryId)?.last_retrieved ?? '';
  const ranked = [...stored].sort((a, b) => {
    const [ra, rb] = [recalled(a), recalled(b)];
    if (ra !== rb) return ra < rb ? 1 : -1;
    return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
  });
  const kept = new Set(ranked.slice(0, max));
  // Load order, not rank order: the force sums run in this order, so a capped run matches an uncapped one over the same
  // set.
  return stored.filter((p) => kept.has(p));
}

function survivorForces(run: SleepRun): ForceContext {
  // Build conflict pairs from survivors
  const conflictPairs = new Map<string, Set<string>>();
  for (const entry of run.survivors) {
    if (entry.conflicts_with.length > 0) {
      const set = conflictPairs.get(entry.id) ?? new Set<string>();
      for (const cid of entry.conflicts_with) set.add(cid);
      conflictPairs.set(entry.id, set);
    }
  }

  // Build half-life lookup
  const halfLives = new Map<string, number>();
  for (const entry of run.survivors) {
    halfLives.set(entry.id, entry.half_life_days);
  }

  return {
    conflictPairs,
    halfLives,
    config: run.config.physics,
  };
}
