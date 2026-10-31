// Particle properties follow the memory they stand for; pure, so sleep refreshes them without reaching the store.
import { evalNow, strengthAblation } from './ablation.js';
import { calculateStrength, type MemoryEntry } from './memory.js';
import { computeCharge, computeMass, computeTemperature, type PhysicsParticle } from './physics.js';
import { DAY_MS } from '../util/time.js';

/**
 * Refresh mass, charge and temperature for existing particles
 * from current memory attributes (called during consolidation).
 */
export function refreshParticleProperties(
  particles: PhysicsParticle[],
  entries: Map<string, MemoryEntry>,
  now: Date = evalNow(),
): void {
  for (const p of particles) {
    const entry = entries.get(p.memoryId);
    if (!entry) continue;

    const strength = calculateStrength(entry, now, { ablation: strengthAblation() });
    const ageDays = (now.getTime() - new Date(entry.created).getTime()) / DAY_MS;

    p.mass = computeMass(strength, entry.retrieval_count);
    p.charge = computeCharge(entry.emotional_valence);
    p.temperature = computeTemperature(ageDays, 1.0);
  }
}
