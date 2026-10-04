import { openHippoDb, closeHippoDb } from '../db.js';
import { loadPhysicsState, savePhysicsState, refreshParticleProperties } from '../physics-state.js';
import { simulate, type ForceContext } from '../physics.js';
import type { SleepRun } from './run.js';

// -------------------------------------------------------------------------
// 2. Physics simulation pass
// -------------------------------------------------------------------------
export function physicsPass(run: SleepRun): void {
  if (run.dryRun) return;
  const { config, result, survivors } = run;
  try {
    const physicsEnabled = config.physics.enabled === true
      || (config.physics.enabled === 'auto');

    if (physicsEnabled) {
      const db = openHippoDb(run.hippoRoot);
      try {
        const physicsMap = loadPhysicsState(db);
        const particles = Array.from(physicsMap.values());

        if (particles.length > 0) {
          // Build entry lookup for property refresh
          const entryMap = new Map(survivors.map(e => [e.id, e]));
          refreshParticleProperties(particles, entryMap, run.now);

          // Build conflict pairs from survivors
          const conflictPairs = new Map<string, Set<string>>();
          for (const entry of survivors) {
            if (entry.conflicts_with.length > 0) {
              const set = conflictPairs.get(entry.id) ?? new Set<string>();
              for (const cid of entry.conflicts_with) set.add(cid);
              conflictPairs.set(entry.id, set);
            }
          }

          // Build half-life lookup
          const halfLives = new Map<string, number>();
          for (const entry of survivors) {
            halfLives.set(entry.id, entry.half_life_days);
          }

          const ctx: ForceContext = {
            conflictPairs,
            halfLives,
            config: config.physics,
          };

          const stats = simulate(particles, ctx);
          savePhysicsState(db, particles);

          result.physicsSimulated = stats.particleCount;
          result.details.push(
            `  ⚛️  physics: ${stats.particleCount} particles, ` +
            `avg vel ${stats.avgVelocityMagnitude.toFixed(4)}, ` +
            `energy ${stats.energy.total.toFixed(4)}`
          );
        }
      } finally {
        closeHippoDb(db);
      }
    }
  } catch (error) {
    result.details.push(`  ⚠️ physics simulation skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
