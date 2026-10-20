import { MemoryEntry, type DecayOptions } from '../../base/memory/memory.js';
import { loadConfig } from '../../base/config/config.js';
import { NO_MERGE_TAGS } from '../sharing/share.js';
import type { DormantMove, StrengthRefresh } from '../../store/port/consolidation.js';
import type { StoreWith } from '../../store/port.js';
import type { SleepRows, Survivors } from './survivors.js';
import type { TombstoneChecks } from './tombstones.js';

export interface ConsolidationResult {
  decayed: number;
  removed: number;
  /** Faded memories moved to the dormant store instead of deleted (config `dormant.enabled`; src/store/dormant.ts).
   *  Always 0 when that is off. */
  dormant: number;
  /** Dormant memories deleted for good this sleep because they outlived `dormant.retentionDays` without a restore. */
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
  // Failed and zero-child counts are first-class so callers (CLI eval, HTTP /v1/sleep) see structured data, not a
  // parsed details string.
  summariesRebuilt: number;
  summariesRebuildFailed: number;
  summariesZeroChildSkipped: number;
  // Hardening pass: tombstone-refused rebuilds are split out of `rebuilt` so the stat does not absorb refusals
  // (metadata is still applied and dirty cleared; counters only, see applyRebuildResult's return contract).
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

/** Re-syncs the full-text index with `memories`; a store open that is already current no longer counts the two. */
export async function syncFtsIndex(
  store: StoreWith<'consolidation'>,
  dryRun: boolean,
  result: ConsolidationResult,
): Promise<void> {
  const counts = await store.consolidation.ftsDrift(!dryRun);
  if (counts === null) return;
  result.details.push(
    `  🔎 ${dryRun ? 'would re-sync' : 're-synced'} the full-text index (${counts.fts} indexed rows for ` +
      `${counts.memories} memories)`,
  );
}

/** The store a consolidation runs on: its own group, and the learning group extraction writes through. */
export type ConsolidationStore = StoreWith<'consolidation' | 'learning'>;

/**
 * State every sleep stage reads or appends to; the pending lists are flushed at the end, each of `units` whole in one
 * transaction.
 */
export interface SleepRun {
  /** The caller's tenant, whose completed sessions become traces. */
  tenantId: string;
  store: ConsolidationStore;
  now: Date;
  dryRun: boolean;
  config: ReturnType<typeof loadConfig>;
  decayOpts: DecayOptions;
  result: ConsolidationResult;
  rows: SleepRows;
  retirable: (entry: MemoryEntry) => boolean;
  /**
   * Auto-promote (1.4) and merge (3) write deterministic content through the guard's bypass, so both check tombstones
   * here first.
   */
  tombstones: TombstoneChecks;
  survivors: Survivors;
  pendingRefreshes: StrengthRefresh[];
  pendingWrites: MemoryEntry[];
  pendingDeletes: string[];
  pendingDormant: DormantMove[];
  /** The DAG parent of each loaded row that has one, for the flush's family units. */
  parentOf: Map<string, string>;
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
