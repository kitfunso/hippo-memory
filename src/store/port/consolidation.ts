// The store work of one sleep, kept apart from port.ts. Plain return values: the passes and their write scopes are
// synchronous, and only the two chunked writers yield between chunks.
import type { MemoryEntry } from '../../core/memory.js';
import type { PhysicsParticle } from '../../core/physics.js';
import type { WriteBudget } from '../../util/write-budget.js';
import type { AppendAuditOpts, AuditOp } from '../audit.js';
import type { DetectedConflict } from '../conflicts.js';
import type { FlushComponent, LoadedRows } from '../delete-and-batch.js';
import type { EntriesWithBase } from '../entry-reads.js';
import type { HalfLifeMove, HalfLifeRows } from '../half-life.js';
import type { SessionDecayContext } from '../index-and-stats.js';
import type { SessionEvent } from '../rows.js';
import type { RebuildPatch } from '../summaries.js';
import type { TombstoneChecks } from '../tombstone-checks.js';

/** What sleep reads and writes on hippo.db, every tenant at once. */
export interface Consolidation {
  /** Every memory of every tenant, with a by-id lookup of each as loaded for the flush to compare against. */
  entriesWithBase(): EntriesWithBase;
  /** The ids of every memory a typed object row names; sleep never retires one. */
  objectBackedIds(): Set<string>;
  /** The full-text index counts when they drift from `memories` (re-synced when `repair`), else null. */
  ftsDrift(repair: boolean): { memories: number; fts: number } | null;
  /** The sleep count and the average interval between recent sleeps. */
  sessionDecayContext(): SessionDecayContext;
  /** Tombstone lookups and refusal audit rows on one lazily opened handle; nothing opens under dryRun. */
  tombstoneChecks(dryRun: boolean): TombstoneChecks;
  /** The default half-life base the memories are on. */
  halfLifeBase(): number;
  /** Plans from one read of the rows, then writes the moves `plan` returns once (nothing under dryRun). */
  moveHalfLives<R>(
    to: number,
    opts: { dryRun: boolean; actor: string },
    plan: (rows: HalfLifeRows) => { moves: readonly HalfLifeMove[]; outcome: R },
  ): { from: number; outcome: R | null };
  /** The tenant's sessions completed since `sinceMs`. */
  promotableSessions(tenantId: string, sinceMs: number): Array<{ session_id: string }>;
  /** True when the tenant already holds a trace for the session. */
  traceExists(tenantId: string, sessionId: string): boolean;
  /** The tenant's session events, filtered as `listSessionEvents` filters them. */
  sessionEvents(tenantId: string, opts: { session_id?: string; limit?: number }): SessionEvent[];
  /** Every stored physics particle, in load order. */
  storedParticles(): PhysicsParticle[];
  /** Writes the particles over their stored state, as one batch. */
  saveParticles(particles: PhysicsParticle[]): void;
  /** Commits each component whole, in chunks the budget paces, under sleep's own lock wait; resolves to the ids it
   * removed. */
  commitFlush(
    components: readonly FlushComponent[],
    opts: { snapshot: LoadedRows; budget: WriteBudget },
  ): Promise<string[]>;
  /** Counts (dryRun) or deletes the dormant memories moved before `cutoffIso`, under sleep's own lock wait. */
  expireDormant(cutoffIso: string, opts: { dryRun: boolean; budget: WriteBudget }): Promise<number>;
  /** Replaces the detected conflicts with these. */
  replaceConflicts(detected: DetectedConflict[], detectedAt: string): void;
  /** Appends one consolidation-run row. */
  recordRun(run: { timestamp: string; decayed: number; merged: number; removed: number }): void;
  /** Adds one to the store's sleep count. */
  countSleep(): void;
  /** Appends each row as its own write; a failed row is logged and counted, and the failures returned as a count. */
  auditEachRow(events: readonly AppendAuditOpts[]): number;
  /** Logs and counts an audit row that could not be written, for a caller whose own write threw. */
  reportAuditFailure(op: AuditOp, reason: string): void;
  /** Every memory of every tenant, as it stands now. */
  allEntries(): MemoryEntry[];
  /** The current distilled memories: no raw row and no superseded one. */
  currentDistilledEntries(): MemoryEntry[];
  /** Deletes each target in its own transaction; true where the row went. */
  deleteOneByOne(
    targets: readonly { id: string; reason: string }[],
    opts: { actor?: string; automatic?: boolean },
  ): boolean[];
  /** The ids of the unit a flush stopped before, if `err` is that stop. */
  failedUnitOf(err: Error | null): string[] | undefined;
  /** Tenants with pending graph work, each with its highest pending queue id. */
  dirtyGraphTenants(): { tenantId: string; maxPendingId: number }[];
  /** Marks the tenant's pending graph work up to `maxId` processed; returns how many rows it marked. */
  markGraphDrained(tenantId: string, maxId: number): number;
  /** Writes one memory through the rejection guard, which throws RejectedValueError on a tombstoned value. */
  writeEntry(entry: MemoryEntry): void;
  /** Writes the memories in one transaction; returns how many it wrote. */
  writeTogether(entries: readonly MemoryEntry[]): number;
  /** Up to `limit` summaries marked dirty. */
  dirtySummaries(limit: number): MemoryEntry[];
  /** The current children of one summary. */
  childrenOfSummary(summaryId: string, tenantId: string): MemoryEntry[];
  /** One read of the children of every summary given, looked up per summary. */
  childrenOfSummaries(
    summaries: ReadonlyArray<{ id: string; tenant_id: string }>,
  ): (summary: { id: string; tenant_id: string }) => MemoryEntry[];
  /** Applies a rebuilt summary while it is still dirty; `refused` when its new content is tombstoned. */
  applyRebuild(summary: MemoryEntry, patch: RebuildPatch): { changed: boolean; refused: boolean };
  /** Clears the dirty mark a fresh summary got from its own child links. */
  clearSummaryDirty(summaryId: string, tenantId: string, actor: string, source?: string): void;
  /** The L2 topic summaries with no L3 profile above them. */
  unprofiledTopicSummaries(): MemoryEntry[];
}
