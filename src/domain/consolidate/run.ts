import { MemoryEntry } from '../../base/memory/entry.js';
import type { DecayBasis, StrengthModel } from '../../base/memory/strength.js';
import type { HippoConfig } from '../../base/config/config.js';
import { NO_MERGE_TAGS } from '../sharing/share.js';
import type {
  DormantMove,
  StrengthRefresh,
  Consolidation,
} from '../../base/ports/store/consolidation.js';
import type { SleepRows, Survivors } from './survivors.js';
import type { TombstoneChecks } from './tombstones.js';
import type { ConsolidateEvent } from './events.js';
import type { HippoStore } from '../../base/ports/store.js';
import type { AuditMaintenance } from '../../base/ports/store/audit.js';
import type { LessonWrites } from '../../base/ports/store/entry-writes.js';
import type { Learning } from '../../base/ports/store/learning.js';

export interface ConsolidationResult {
  decayed: number;
  removed: number;
  /** Faded memories moved to the dormant store instead of deleted (config `dormant.enabled`;
   *  sqlite/dormant/dormant.ts). Always 0 when that is off. */
  dormant: number;
  /** Dormant memories deleted for good this sleep because they outlived `dormant.retentionDays`
   * without a restore. */
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
  // Failed and zero-child counts are first-class so callers (CLI eval, HTTP /v1/sleep) see
  // structured data, not a parsed line.
  summariesRebuilt: number;
  summariesRebuildFailed: number;
  summariesZeroChildSkipped: number;
  // Hardening pass: tombstone-refused rebuilds are split out of `rebuilt` so the stat does not
  // absorb refusals (metadata is still applied and dirty cleared; counters only, see
  // applyRebuildResult's return contract).
  summariesRebuildRefused: number;
  summariesRebuildCapped: boolean;
  entityProfilesCreated: number;
  dryRun: boolean;
  /** What the run did, in order; the CLI and /v1/sleep render each event as a line. */
  events: ConsolidateEvent[];
  /** Ids the decay pass removes (or would remove, under dryRun). */
  removedIds?: string[];
}

export const REPLAY_COUNT_DEFAULT = 5;

export function keptAsWritten(entry: MemoryEntry): boolean {
  return entry.tags.some((tag) => NO_MERGE_TAGS.has(tag));
}

/** The store a consolidation runs on: its own group, the learning group extraction writes
 * through, and the lesson and audit writes its passes make. */
export type ConsolidationStore = HippoStore & {
  readonly hippoDb: {
    readonly consolidation: Consolidation;
    readonly learning: Learning;
    readonly lessonWrites: LessonWrites;
    readonly auditMaintenance: AuditMaintenance;
  };
};

/**
 * State every sleep stage reads or appends to; the pending lists are flushed at the end, each of
 * `units` whole in one transaction.
 */
export interface SleepRun {
  /** The caller's tenant, whose completed sessions become traces. */
  tenantId: string;
  store: ConsolidationStore;
  now: Date;
  dryRun: boolean;
  config: HippoConfig;
  decayOpts: DecayBasis;
  /** The model every strength this run reads is scored by. */
  strength: StrengthModel;
  result: ConsolidationResult;
  rows: SleepRows;
  retirable: (entry: MemoryEntry) => boolean;
  /**
   * Auto-promote (1.4) and merge (3) write deterministic content through the guard's bypass, so
   * both check tombstones here first.
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
    events: [],
  };
}
