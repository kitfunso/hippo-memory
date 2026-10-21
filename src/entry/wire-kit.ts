// The eval kit's snake_case forms. Frozen eval scripts read and write MemoryWire keys, so each function here wraps the
// domain function its name starts with and converts at the edge; a script takes one by re-pointing its import line.

import { ambientSecretAdmit } from '../base/scope/read-admission.js';
import { isWorthSurfacing } from '../base/memory/memory-quality.js';
import { calculateStrength, createMemory, type CreateMemoryOptions, type DecayOptions } from '../base/memory/memory.js';
import { fromWire, toWire, type MemoryWire } from '../base/memory/memory-wire.js';
import type { ProjectRef } from '../base/scope/project-identity.js';
import type { SearchResult } from '../base/rank/search-types.js';
import { evalNow } from '../base/memory/ablation.js';
import type { HybridSearchOptions } from '../domain/search/hybrid.js';
import type { EmbedOutcome } from '../domain/search/embed-memories.js';
import { embedMemory, hybridSearch } from './folder-search.js';

/** A search hit whose entry carries the wire keys. */
export type WireSearchResult = Omit<SearchResult, 'entry'> & { entry: MemoryWire };

/** The fields calculateStrength reads, by their wire keys. */
export type WireStrengthInputs = Pick<
  MemoryWire,
  | 'pinned'
  | 'created'
  | 'last_retrieved'
  | 'half_life_days'
  | 'retrieval_count'
  | 'emotional_valence'
  | 'outcome_positive'
  | 'outcome_negative'
>;

export function createMemoryWire(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryWire {
  // SAFETY: the one missing field is baseHalfLifeDays, and memory.ts defaults it when absent.
  return toWire(createMemory(content, options as CreateMemoryOptions));
}

export function embedMemoryWire(hippoRoot: string, entry: MemoryWire): Promise<EmbedOutcome> {
  return embedMemory(hippoRoot, fromWire(entry));
}

export async function hybridSearchWire(
  query: string,
  entries: MemoryWire[],
  options: HybridSearchOptions = {},
): Promise<WireSearchResult[]> {
  const results = await hybridSearch(query, entries.map(fromWire), options);
  return results.map((r) => ({ ...r, entry: toWire(r.entry) }));
}

export function calculateStrengthWire(
  entry: WireStrengthInputs,
  now: Date = evalNow(),
  options: DecayOptions = {},
): number {
  return calculateStrength(
    {
      pinned: entry.pinned,
      created: entry.created,
      lastRetrieved: entry.last_retrieved,
      halfLifeDays: entry.half_life_days,
      retrievalCount: entry.retrieval_count,
      emotionalValence: entry.emotional_valence,
      outcomePositive: entry.outcome_positive,
      outcomeNegative: entry.outcome_negative,
    },
    now,
    options,
  );
}

export function isWorthSurfacingWire(entry: MemoryWire): boolean {
  return isWorthSurfacing(fromWire(entry));
}

export function ambientSecretAdmitWire(entry: MemoryWire, currentProject: ProjectRef): boolean {
  return ambientSecretAdmit(fromWire(entry), currentProject);
}
