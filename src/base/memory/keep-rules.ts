// Which memories sleep may never delete, and how an outcome mark changes an entry.
import { AGENT_MEMORY_TOOLS, toolSourcePrefix } from './agent-memory-tools.js';
import { CHURN_STALE_TAG, type MemoryEntry } from './entry.js';
import { isSuperseded } from './liveness.js';
import {
  CONFLICT_LOSER_TAG,
  INVALIDATED_TAG,
  REPLACED_BY_PREFIX,
  SUPERSEDED_TAG,
} from './stale-mark.js';
import { calculateStrength, type StrengthModel } from './strength.js';

/** An imported agent memory is kept for good: the agent's note file is its record. It needs its
 * tool's tag and a source with that tool's prefix, since merge copies source tags onto rows
 * whose source is 'consolidation'. */
export interface KeepPair {
  readonly tag: string;
  readonly sourcePrefix: string;
}
export const KEEP_PAIRS: readonly KeepPair[] = AGENT_MEMORY_TOOLS.map((t) => ({
  tag: t.tag,
  sourcePrefix: toolSourcePrefix(t.id),
}));

export function isKeptForGood(
  entry: Pick<MemoryEntry, 'tags' | 'source' | 'supersededBy'>,
): boolean {
  return (
    !isSuperseded(entry) &&
    KEEP_PAIRS.some((p) => entry.tags.includes(p.tag) && entry.source.startsWith(p.sourcePrefix))
  );
}
export function canAutoDelete(
  entry: Pick<MemoryEntry, 'pinned' | 'kind' | 'tags' | 'source' | 'supersededBy'>,
): boolean {
  return !entry.pinned && entry.kind !== 'raw' && !isKeptForGood(entry);
}

/** Counts the outcome and scores the entry at `now`; calculateStrength turns the counts into a
 * reward factor on the half-life, so there is no fixed delta here. */
export function applyOutcome(
  entry: MemoryEntry,
  good: boolean,
  now: Date,
  model: StrengthModel,
): MemoryEntry {
  const updated: MemoryEntry = {
    ...entry,
    outcomeScore: good ? 1 : -1,
    outcomePositive: (entry.outcomePositive ?? 0) + (good ? 1 : 0),
    outcomeNegative: (entry.outcomeNegative ?? 0) + (good ? 0 : 1),
  };
  updated.strength = calculateStrength(updated, now, model);
  return updated;
}

const isSleepStaleMark = (tag: string): boolean =>
  tag === CONFLICT_LOSER_TAG || tag.startsWith(REPLACED_BY_PREFIX);

/** applyOutcome as a served outcome applies it: a good outcome reconfirms the entry, so its
 * churn-stale tag goes, and so does a sleep stale mark (conflict-loser or replaced-by:) with its
 * stale confidence unless a person or a decision also marked the row. */
export function entryAfterOutcome(
  entry: MemoryEntry,
  good: boolean,
  now: Date,
  model: StrengthModel,
): MemoryEntry {
  const updated = applyOutcome(entry, good, now, model);
  if (!good) return updated;
  const sleepStale = updated.confidence === 'stale' && updated.tags.some(isSleepStaleMark);
  const tags = updated.tags.filter(
    (t) => t !== CHURN_STALE_TAG && !(sleepStale && isSleepStaleMark(t)),
  );
  const byPerson = tags.includes(INVALIDATED_TAG) || tags.includes(SUPERSEDED_TAG);
  const confidence = sleepStale && !byPerson ? 'observed' : updated.confidence;
  if (tags.length === updated.tags.length && confidence === updated.confidence) return updated;
  return { ...updated, tags, confidence };
}
