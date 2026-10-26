// Which memories sleep may never delete, and how an outcome mark changes an entry.
import { AGENT_MEMORY_TOOLS, toolSourcePrefix } from './agent-memory-tools.js';
import { CHURN_STALE_TAG, type MemoryEntry } from './entry.js';
import { calculateStrength, type StrengthModel } from './strength.js';

/** An imported agent memory is kept for good: the agent's note file is its record. It needs its tool's tag and a source
 * with that tool's prefix, since merge copies source tags onto rows whose source is 'consolidation'. */
export interface KeepPair {
  readonly tag: string;
  readonly sourcePrefix: string;
}
export const KEEP_PAIRS: readonly KeepPair[] = AGENT_MEMORY_TOOLS.map((t) => ({
  tag: t.tag,
  sourcePrefix: toolSourcePrefix(t.id),
}));

export function isKeptForGood(entry: Pick<MemoryEntry, 'tags' | 'source' | 'supersededBy'>): boolean {
  return (
    !entry.supersededBy && KEEP_PAIRS.some((p) => entry.tags.includes(p.tag) && entry.source.startsWith(p.sourcePrefix))
  );
}
export function canAutoDelete(
  entry: Pick<MemoryEntry, 'pinned' | 'kind' | 'tags' | 'source' | 'supersededBy'>,
): boolean {
  return !entry.pinned && entry.kind !== 'raw' && !isKeptForGood(entry);
}

/** Counts the outcome and scores the entry at `now`; calculateStrength turns the counts into a reward factor on the
 * half-life, so there is no fixed delta here. */
export function applyOutcome(entry: MemoryEntry, good: boolean, now: Date, model: StrengthModel): MemoryEntry {
  const updated: MemoryEntry = {
    ...entry,
    outcomeScore: good ? 1 : -1,
    outcomePositive: (entry.outcomePositive ?? 0) + (good ? 1 : 0),
    outcomeNegative: (entry.outcomeNegative ?? 0) + (good ? 0 : 1),
  };
  updated.strength = calculateStrength(updated, now, model);
  return updated;
}

/** applyOutcome as a served outcome applies it: a good outcome reconfirms the entry, so its churn-stale tag goes. */
export function entryAfterOutcome(entry: MemoryEntry, good: boolean, now: Date, model: StrengthModel): MemoryEntry {
  const updated = applyOutcome(entry, good, now, model);
  if (!good || !updated.tags.includes(CHURN_STALE_TAG)) return updated;
  return { ...updated, tags: updated.tags.filter((t) => t !== CHURN_STALE_TAG) };
}
