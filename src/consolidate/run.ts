import { MemoryEntry, type DecayOptions } from '../memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
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
  /** T7: sessions skipped because their events span two derivation scopes. */
  tracesSkippedMixedScope: number;
  extractionCandidates: number;
  extracted: number;
  dagCandidateClusters: number;
  dagSummariesCreated: number;
  // v0.30 / E3 — rebuild phase observability. Failed and zero-child counts
  // are first-class so downstream callers (CLI eval, HTTP /v1/sleep response)
  // see structured data, not a parsed details string.
  summariesRebuilt: number;
  summariesRebuildFailed: number;
  summariesZeroChildSkipped: number;
  // Hardening pass: tombstone-refused rebuilds split out of `rebuilt` so the
  // stat no longer silently absorbs refusals (metadata still applied, dirty
  // still cleared - counters only; see applyRebuildResult's return contract).
  summariesRebuildRefused: number;
  summariesRebuildCapped: boolean;
  // v0.30 / E5 — L3 entity-profile build count
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

/** JSON value shape for a session event's free-form metadata field, cast to
 *  once at its `Record<string, unknown>` origin so it can be narrowed via
 *  isJsonString below rather than left as unparsed `unknown`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isJsonString(value: JsonValue): value is string {
  return typeof value === 'string';
}

/** The sleep's one tombstone-check handle: opened on first use, never under dryRun, closed once. */
interface LazyDb {
  get: () => DatabaseSyncLike | null;
  close: () => void;
}

// AT1 rejection-guard db handle (docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
// covers BOTH the auto-promote pass (1.4) and the merge
// pass (3) — both build deterministic content that
// batchWriteAndDelete writes through the guard's bypass, so both need a
// producer-side tombstone check before pushing to pendingWrites.
//
// T3 fix (2026-08-15 hardening pass, perf hygiene): memoized lazy getter,
// not an eager open. The handle only serves these two tombstone checks —
// a sleep with zero promotable sessions and zero merge clusters never
// reaches either use site, so opening it unconditionally on every
// non-dry-run sleep paid a db-open cost for nothing. dryRun still never
// opens (getConsolidateDb short-circuits before touching the handle).
// consolidateDbOpened (not just a truthy handle check) is the
// single source of truth for "was this ever opened", so the finally
// closes it exactly once and never double-opens.
//
// AT1 P2 fix (codex, handle-leak restructure): the getter's lifetime must
// start IMMEDIATELY before the try whose finally closes it, covering every
// phase that can touch it — not just the merge pass. An exception thrown by
// auto-promote (1.4), replay (1.5), batch extraction (1.6), the DAG
// passes (1.7-1.9), or physics (2) would otherwise propagate past an open handle
// with nothing to close it.
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

/** State every sleep stage reads or appends to; the pending lists are flushed in one transaction at the end. */
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
