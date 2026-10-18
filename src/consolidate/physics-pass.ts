import { refreshParticleProperties } from '../core/particle-refresh.js';
import { simulate, type ForceContext } from '../core/physics.js';
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
    const physicsEnabled = config.physics.enabled === true || config.physics.enabled === 'auto';

    if (physicsEnabled) simulateStoredParticles(run, maxParticles);
  } catch (error) {
    result.details.push(`  ⚠️ physics simulation skipped: ${errorMessage(error)}`);
  }
}

function simulateStoredParticles(run: SleepRun, maxParticles: number): void {
  const { result, survivors } = run;
  const storedIds = run.store.particleIds();
  if (storedIds.length === 0) return;

  const ids = particlesToSimulate(storedIds, recallTimes(run, storedIds.length > maxParticles), maxParticles);
  const particles = run.store.particlesByIds(ids);
  // Only the simulated particles' rows: the refresh and every force lookup read no other id.
  const entryMap = new Map(survivors.get(particles.map((p) => p.memoryId)).map((e) => [e.id, e]));
  refreshParticleProperties(particles, entryMap, run.now);

  const stats = simulate(particles, survivorForces(run, entryMap));
  run.store.saveParticles(particles);

  result.physicsSimulated = stats.particleCount;
  const capped =
    particles.length < storedIds.length
      ? ` (the ${particles.length} most recently recalled of ${storedIds.length})`
      : '';
  result.details.push(
    `  ⚛️  physics: ${stats.particleCount} particles${capped}, ` +
      `avg vel ${stats.avgVelocityMagnitude.toFixed(STATS_DECIMALS)}`,
  );
}

/** Each survivor's last recall, read only when the cap applies. */
function recallTimes(run: SleepRun, capped: boolean): Map<string, Pick<MemoryEntry, 'lastRetrieved'>> {
  const times = new Map<string, Pick<MemoryEntry, 'lastRetrieved'>>();
  if (!capped) return times;
  for (const e of run.survivors.rows()) times.set(e.id, { lastRetrieved: e.lastRetrieved });
  return times;
}

/**
 * Every stored particle id in load order up to the cap; past it, the most recently recalled survivors (memory id
 * breaks ties), then particles with no survivor. */
export function particlesToSimulate(
  stored: readonly string[],
  entries: ReadonlyMap<string, Pick<MemoryEntry, 'lastRetrieved'>>,
  max: number = SLEEP_PHYSICS_MAX_PARTICLES,
): readonly string[] {
  if (stored.length <= max) return stored;
  const recalled = (id: string): string => entries.get(id)?.lastRetrieved ?? '';
  const ranked = [...stored].sort((a, b) => {
    const [ra, rb] = [recalled(a), recalled(b)];
    if (ra !== rb) return ra < rb ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const kept = new Set(ranked.slice(0, max));
  // Load order, not rank order: the force sums run in this order, so a capped run matches an uncapped one over the same
  // set.
  return stored.filter((id) => kept.has(id));
}

/** The forces among `entries`, the survivors behind the simulated particles: the simulation looks up no other id. */
function survivorForces(run: SleepRun, entries: ReadonlyMap<string, MemoryEntry>): ForceContext {
  const conflictPairs = new Map<string, Set<string>>();
  const halfLives = new Map<string, number>();
  for (const entry of entries.values()) {
    if (entry.conflictsWith.length > 0) conflictPairs.set(entry.id, new Set(entry.conflictsWith));
    halfLives.set(entry.id, entry.halfLifeDays);
  }
  return {
    conflictPairs,
    halfLives,
    config: run.config.physics,
  };
}
