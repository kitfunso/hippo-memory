// How a dormant memory comes back: the api states the scoring as data and the store applies this
// rule inside its write.
import { calculateStrengthAt, type StrengthModel } from './strength.js';
import { createMemoryAt, type MemoryEntry } from './entry.js';

/** A revived row's scoring: a fresh half-life of `halfLifeDays` days, and its strength under
 * `strength`. */
export interface DormantRevival {
  readonly halfLifeDays: number;
  readonly strength: StrengthModel;
}

/** The dormant row as if just recalled at `now`; a row set aside by audit repair comes back
 * `verified`. */
export function reviveDormant(
  dormant: { readonly entry: MemoryEntry; readonly reason: string },
  now: Date,
  revival: DormantRevival,
): MemoryEntry {
  // createMemoryAt fills fields a snapshot predates; its placeholder only meets the minimum length,
  // so a short row restores.
  const revived: MemoryEntry = {
    ...createMemoryAt('dormant snapshot defaults', { baseHalfLifeDays: revival.halfLifeDays }, now),
    ...dormant.entry,
    lastRetrieved: now.toISOString(),
  };
  if (dormant.reason === 'quality-repair') revived.confidence = 'verified';
  return { ...revived, strength: calculateStrengthAt(revived, now, revival.strength) };
}
