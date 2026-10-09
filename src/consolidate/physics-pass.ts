import { refreshParticleProperties } from '../db/physics-state.js';
import { loadStoredParticles, saveStoredParticles } from '../store/vector-writes.js';
import { simulate, type ForceContext } from '../core/physics.js';
import type { SleepRun } from './run.js';
import { errorMessage } from '../util/log.js';

const STATS_DECIMALS = 4;

// -------------------------------------------------------------------------
// 2. Physics simulation pass
// -------------------------------------------------------------------------
export function physicsPass(run: SleepRun): void {
  if (run.dryRun) return;
  const { config, result } = run;
  try {
    const physicsEnabled = config.physics.enabled === true
      || (config.physics.enabled === 'auto');

    if (physicsEnabled) simulateStoredParticles(run);
  } catch (error) {
    result.details.push(`  ⚠️ physics simulation skipped: ${errorMessage(error)}`);
  }
}

function simulateStoredParticles(run: SleepRun): void {
  const { result, survivors } = run;
  const particles = loadStoredParticles(run.hippoRoot);
  if (particles.length === 0) return;

  // Build entry lookup for property refresh
  const entryMap = new Map(survivors.map(e => [e.id, e]));
  refreshParticleProperties(particles, entryMap, run.now);

  const stats = simulate(particles, survivorForces(run));
  saveStoredParticles(run.hippoRoot, particles);

  result.physicsSimulated = stats.particleCount;
  result.details.push(
    `  ⚛️  physics: ${stats.particleCount} particles, ` +
    `avg vel ${stats.avgVelocityMagnitude.toFixed(STATS_DECIMALS)}, ` +
    `energy ${stats.energy.total.toFixed(STATS_DECIMALS)}`
  );
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
