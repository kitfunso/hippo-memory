// The eval kit's snake_case forms. Frozen eval scripts read and write MemoryWire keys, so each function here wraps the
// domain function its name starts with and converts at the edge; a script takes one by re-pointing its import line.

import { ambientSecretAdmit } from '../core/read-admission.js';
import { isWorthSurfacing } from '../core/memory-quality.js';
import {
  calculateStrength,
  createMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type DecayOptions,
} from '../core/memory.js';
import { fromWire, toWire, type MemoryWire } from '../core/memory-wire.js';
import type { ProjectRef } from '../core/project-identity.js';
import type { SearchResult } from '../core/search-types.js';
import { evalNow } from '../core/ablation.js';
import type { HybridSearchOptions } from '../search/hybrid.js';
import type { EmbedOutcome } from '../search/embed-memories.js';
import { upsertEntryRow } from '../store/sqlite/entry-row.js';
import type { WriteEntryOptions } from '../store/sqlite/entry-writes.js';
import { batchWriteAndDelete, loadAllEntries, writeEntry } from '../store/sqlite/folder-forms.js';
import type { openHippoDb } from '../db/index.js';
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
  return toWire(
    createMemory(content, { ...options, baseHalfLifeDays: options.baseHalfLifeDays ?? DEFAULT_HALF_LIFE_DAYS }),
  );
}

export function loadAllEntriesWire(hippoRoot: string): MemoryWire[] {
  return loadAllEntries(hippoRoot).map(toWire);
}

export function writeEntryWire(hippoRoot: string, entry: MemoryWire, opts?: WriteEntryOptions): void {
  writeEntry(hippoRoot, fromWire(entry), opts);
}

export function upsertEntryRowWire(db: ReturnType<typeof openHippoDb>, entry: MemoryWire): void {
  upsertEntryRow(db, fromWire(entry));
}

export function batchWriteAndDeleteWire(hippoRoot: string, toWrite: MemoryWire[], toDeleteIds: string[]): string[] {
  return batchWriteAndDelete(hippoRoot, toWrite.map(fromWire), toDeleteIds);
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
      last_retrieved: entry.last_retrieved,
      half_life_days: entry.half_life_days,
      retrieval_count: entry.retrieval_count,
      emotional_valence: entry.emotional_valence,
      outcome_positive: entry.outcome_positive,
      outcome_negative: entry.outcome_negative,
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
