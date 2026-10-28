import { refreshParticleProperties } from '../../base/rank/particle-refresh.js';
import { simulate, type ForceContext } from '../../base/rank/physics.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { RecallCursor, RecalledMemory } from '../../base/ports/store/consolidation.js';
import { recordPhaseFailure, type SleepRun } from './run.js';

// Every substep is all-pairs, so one sleep moves at most this many particles; the rest keep their
// stored state until they are recalled.
const SLEEP_PHYSICS_MAX_PARTICLES = 1000;

export async function physicsPass(
  run: SleepRun,
  maxParticles: number = SLEEP_PHYSICS_MAX_PARTICLES,
): Promise<void> {
  if (run.dryRun) return;
  const { config, result } = run;
  try {
    const physicsEnabled = config.physics.enabled === true || config.physics.enabled === 'auto';

    if (physicsEnabled) await simulateStoredParticles(run, maxParticles);
  } catch (error) {
    recordPhaseFailure(result, 'physics', error);
  }
}

async function simulateStoredParticles(run: SleepRun, maxParticles: number): Promise<void> {
  const { result, survivors } = run;
  const { consolidation } = run.store;
  const storedIds = await consolidation.particleIds();
  if (storedIds.length === 0) return;

  const recalled = await recalledSurvivors(run, storedIds, maxParticles);
  const ids = particlesToSimulate(storedIds, recalled, maxParticles);
  const stored = await run.store.vectors.stored('particles', ids);
  const particles = ids.flatMap((id) => stored.get(id) ?? []);
  // Only the simulated particles' rows: the refresh and every force lookup read no other id.
  const entryMap = new Map(
    (await survivors.get(particles.map((p) => p.memoryId))).map((e) => [e.id, e]),
  );
  refreshParticleProperties(particles, entryMap, run.now, run.strength);

  const stats = simulate(particles, survivorForces(run, entryMap));
  const simulatedAt = run.now.toISOString();
  for (const p of particles) p.lastSimulation = simulatedAt;
  await consolidation.saveParticles(particles);

  result.physicsSimulated = stats.particleCount;
  result.events.push({
    kind: 'physics',
    particles: stats.particleCount,
    shown: particles.length,
    stored: storedIds.length,
    avgVelocity: stats.avgVelocityMagnitude,
  });
}

/** The `max` survivors among the stored particles recalled last, only when the cap applies. A row
 * this run changed ranks by the run's own recall time, which the store does not hold yet. */
async function recalledSurvivors(
  run: SleepRun,
  stored: readonly string[],
  max: number,
): Promise<string[]> {
  if (stored.length <= max) return [];
  const particles = new Set(stored);
  const changed = run.survivors
    .changed()
    .filter((row) => particles.has(row.id))
    .sort((a, b) => cmpDesc(a.lastRetrieved, b.lastRetrieved));
  const changedIds = new Set(changed.map((row) => row.id));
  const kept = await storedByRecall(run, max, (id) => !changedIds.has(id) && run.survivors.has(id));
  return mergeByRecall(changed, kept).slice(0, max);
}

/** Up to `max` memories the store holds in recall order that `keep` admits, page by page. */
async function storedByRecall(
  run: SleepRun,
  max: number,
  keep: (id: string) => boolean,
): Promise<RecalledMemory[]> {
  const found: RecalledMemory[] = [];
  let after: RecallCursor | undefined;
  while (found.length < max) {
    const page = await run.store.consolidation.particlesByRecall({ limit: max, after });
    for (const m of page.memories) if (keep(m.id) && found.length < max) found.push(m);
    if (!page.next) break;
    after = page.next;
  }
  return found;
}

const cmpDesc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

// At one recall time a row this run recalled goes first: the run's recall is the later one.
function mergeByRecall(
  changed: readonly RecalledMemory[],
  stored: readonly RecalledMemory[],
): string[] {
  const out: string[] = [];
  let [c, s] = [0, 0];
  while (c < changed.length || s < stored.length) {
    const takeChanged =
      s >= stored.length ||
      (c < changed.length && changed[c]!.lastRetrieved >= stored[s]!.lastRetrieved);
    out.push(takeChanged ? changed[c++]!.id : stored[s++]!.id);
  }
  return out;
}

/**
 * Every stored particle id in load order up to the cap; past it, the `recalled` survivors (most
 * recently recalled first), then the other particles by memory id. */
export function particlesToSimulate(
  stored: readonly string[],
  recalled: readonly string[],
  max: number = SLEEP_PHYSICS_MAX_PARTICLES,
): readonly string[] {
  if (stored.length <= max) return stored;
  const kept = new Set(recalled.slice(0, max));
  const rest = stored.filter((id) => !kept.has(id)).sort();
  for (const id of rest.slice(0, max - kept.size)) kept.add(id);
  // Load order, not rank order: the force sums run in this order, so a capped run matches an
  // uncapped one over the same set.
  return stored.filter((id) => kept.has(id));
}

/** The forces among `entries`, the survivors behind the simulated particles: the simulation
 * looks up no other id. */
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
