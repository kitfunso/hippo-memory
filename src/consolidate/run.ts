import { MemoryEntry, type DecayOptions } from '../memory.js';
import { openHippoDb, closeHippoDb, ftsRowCounts, isFtsAvailable, repairFtsDrift, type DatabaseSyncLike } from '../db.js';
import { type DormantMove } from '../dormant.js';
import { loadConfig } from '../config.js';
import { NO_MERGE_TAGS } from '../shared.js';

export interface ConsolidationResult {
  decayed: number;
  removed: number;
  /** Faded memories moved to the dormant store instead of deleted (config
   *  `dormant.enabled`; src/dormant.ts). Always 0 when that is off. */
  dormant: number;
  /** Dormant memories deleted for good this sleep because they outlived
   *  `dormant.retentionDays` without a restore. */
  dormantExpired: number;
  merged: number;
  semanticCreated: number;
  replayed: number;
  promotedTraces: number;
  /** Sessions skipped because their events span two derivation scopes. */
  tracesSkippedMixedScope: number;
  extractionCandidates: number;
  extracted: number;
  dagCandidateClusters: number;
  dagSummariesCreated: number;
  // Failed and zero-child counts are first-class so callers (CLI eval, HTTP /v1/sleep)
  // see structured data, not a parsed details string.
  summariesRebuilt: number;
  summariesRebuildFailed: number;
  summariesZeroChildSkipped: number;
  // Hardening pass: tombstone-refused rebuilds split out of `rebuilt` so the
  // stat no longer silently absorbs refusals (metadata still applied, dirty
  // still cleared - counters only; see applyRebuildResult's return contract).
  summariesRebuildRefused: number;
  summariesRebuildCapped: boolean;
  entityProfilesCreated: number;
  dryRun: boolean;
  details: string[];
  physicsSimulated: number;
  /** Ids the decay pass removes (or would remove, under dryRun). */
  removedIds?: string[];
}

export const REPLAY_COUNT_DEFAULT = 5;

export function keptAsWritten(entry: MemoryEntry): boolean {
  return entry.tags.some((tag) => NO_MERGE_TAGS.has(tag));
}

/** The sleep's one tombstone-check handle: opened on first use, never under dryRun, closed once. */
interface LazyDb {
  get: () => DatabaseSyncLike | null;
  close: () => void;
}

// Auto-promote (1.4) and merge (3) write deterministic content through the guard's bypass, so both
// need this tombstone check. Lazy so a sleep reaching neither never opens it; call it IMMEDIATELY
// before the try whose finally closes it, so a throw in any phase cannot leak the handle.
export function lazyConsolidateDb(hippoRoot: string, dryRun: boolean): LazyDb {
  let consolidateDbHandle: DatabaseSyncLike | null = null;
  let consolidateDbOpened = false;
  const get = (): DatabaseSyncLike | null => {
    if (dryRun) return null;
    if (!consolidateDbOpened) {
      consolidateDbHandle = openHippoDb(hippoRoot);
      consolidateDbOpened = true;
    }
    return consolidateDbHandle;
  };
  const close = (): void => {
    if (consolidateDbHandle) closeHippoDb(consolidateDbHandle);
  };
  return { get, close };
}

/** Re-syncs the full-text index with `memories`; a store open that is already current no longer counts the two. */
export function syncFtsIndex(hippoRoot: string, dryRun: boolean, result: ConsolidationResult): void {
  const db = openHippoDb(hippoRoot);
  try {
    if (!isFtsAvailable(db)) return;
    const counts = ftsRowCounts(db);
    if (counts === null || counts.memories === counts.fts) return;
    if (!dryRun) repairFtsDrift(db);
    result.details.push(`  🔎 ${dryRun ? 'would re-sync' : 're-synced'} the full-text index (${counts.fts} indexed rows for ${counts.memories} memories)`);
  } finally {
    closeHippoDb(db);
  }
}

/** State every sleep stage reads or appends to; the pending lists are flushed at the end, each of `units` whole in one transaction. */
export interface SleepRun {
  hippoRoot: string;
  now: Date;
  dryRun: boolean;
  config: ReturnType<typeof loadConfig>;
  decayOpts: DecayOptions;
  result: ConsolidationResult;
  all: MemoryEntry[];
  retirable: (entry: MemoryEntry) => boolean;
  getConsolidateDb: () => DatabaseSyncLike | null;
  survivors: MemoryEntry[];
  pendingWrites: MemoryEntry[];
  pendingDeletes: string[];
  pendingDormant: DormantMove[];
  units: string[][];
}

export function newConsolidationResult(dryRun: boolean): ConsolidationResult {
  return {
    decayed: 0,
    removed: 0,
    dormant: 0,
    dormantExpired: 0,
    merged: 0,
    semanticCreated: 0,
    replayed: 0,
    promotedTraces: 0,
    tracesSkippedMixedScope: 0,
    extractionCandidates: 0,
    extracted: 0,
    dagCandidateClusters: 0,
    dagSummariesCreated: 0,
    summariesRebuilt: 0,
    summariesRebuildFailed: 0,
    summariesZeroChildSkipped: 0,
    summariesRebuildRefused: 0,
    summariesRebuildCapped: false,
    entityProfilesCreated: 0,
    dryRun,
    details: [],
    physicsSimulated: 0,
  };
}
