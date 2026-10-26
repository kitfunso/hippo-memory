// Particle properties follow the memory they stand for; pure, so sleep refreshes them without reaching the store.
import { calculateStrength, type StrengthModel } from '../memory/strength.js';
import type { MemoryEntry } from '../memory/entry.js';
import { computeCharge, computeMass, computeTemperature, type PhysicsParticle } from './physics.js';
import { DAY_MS } from '../util/time.js';

/**
 * Refresh mass, charge and temperature for existing particles from current memory attributes (called during
 * consolidation).
 */
export function refreshParticleProperties(
  particles: PhysicsParticle[],
  entries: Map<string, MemoryEntry>,
  now: Date,
  model: StrengthModel,
): void {
  for (const p of particles) {
    const entry = entries.get(p.memoryId);
    if (!entry) continue;

    const strength = calculateStrength(entry, now, model);
    const ageDays = (now.getTime() - new Date(entry.created).getTime()) / DAY_MS;

    p.mass = computeMass(strength, entry.retrievalCount, model);
    p.charge = computeCharge(entry.emotionalValence);
    p.temperature = computeTemperature(ageDays, 1.0);
  }
}
