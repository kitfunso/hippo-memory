// The store work of one sleep, kept apart from port.ts. Plain return values: the passes and their write scopes are
// synchronous, and only the two chunked writers yield between chunks.
import type { MemoryEntry } from '../../core/memory.js';
import type { PhysicsParticle } from '../../core/physics.js';
import type { WriteBudget } from '../../util/write-budget.js';
import type { SessionEvent } from './sessions.js';
import type { AppendAuditOpts } from './types.js';
import type { AuditOp } from '../../core/audit-ops.js';
import type { RejectedValueRow } from './rejections.js';

/** What sleep reads and writes on hippo.db, every tenant at once. */
export interface Consolidation {
  /** Up to `page.limit` memory ids of every tenant, by created then id, after `page.after`. */
  entryIdsPage(page: { readonly limit: number; readonly after?: EntryCursor }): EntryIdPage;
  /** The rows for `ids` by id; an id deleted since it was listed is absent. */
  entriesByIds(ids: readonly string[]): Map<string, MemoryEntry>;
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
  /** The memory id of every stored physics particle, in load order. */
  particleIds(): string[];
  /** The stored particles for `ids`, in that order; an id with no particle is skipped. */
  particlesByIds(ids: readonly string[]): PhysicsParticle[];
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
  /** Up to `limit` memories of every tenant after `after`, by created then id, so a pass holds one page at a time. */
  entriesPage(page: { readonly limit: number; readonly after?: EntryCursor }): EntryPage;
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
    summaries: ReadonlyArray<{ id: string; tenantId: string }>,
  ): (summary: { id: string; tenantId: string }) => MemoryEntry[];
  /** Applies a rebuilt summary while it is still dirty; `refused` when its new content is tombstoned. */
  applyRebuild(summary: MemoryEntry, patch: RebuildPatch): { changed: boolean; refused: boolean };
  /** Clears the dirty mark a fresh summary got from its own child links. */
  clearSummaryDirty(summaryId: string, tenantId: string, actor: string, source?: string): void;
  /** The L2 topic summaries with no L3 profile above them. */
  unprofiledTopicSummaries(): MemoryEntry[];
}

export type DetectedConflict = { memory_a_id: string; memory_b_id: string; reason: string; score: number };

/** Ops that must commit in one transaction, so a flush split across several never lands part of one. */
export interface FlushComponent {
  /** Decay's new strengths, each set on the row as it stands at commit; they go before `writes`. */
  refreshes: readonly StrengthRefresh[];
  writes: readonly MemoryEntry[];
  deletes: readonly string[];
  dormant: readonly DormantMove[];
}

/** A stored strength decay recomputed; a row gone by the flush is skipped. */
export interface StrengthRefresh {
  id: string;
  strength: number;
}

/** One memory that sleep is moving out of active memory into the dormant store. */
export interface DormantMove {
  /** The memory as it stood when it faded; restored verbatim apart from its recall clock. */
  entry: MemoryEntry;
  /** Live strength at the moment it went dormant (below the decay threshold). */
  strength: number;
  reason: DormantReason;
  /** ISO time of the sleep that made it dormant. */
  dormantAt: string;
}

/** Why a memory went dormant: sleep's decay pass, an imported agent memory whose note was deleted, `hippo projects
 * repair` splitting a two-project merge, or `hippo audit repair` setting aside an automatic memory with a certain
 * defect. */
export type DormantReason = 'decay' | 'source-deleted' | 'project-repair' | 'quality-repair';

/** Each row as the caller loaded it, by id; a `ReadonlyMap` fits. */
export type LoadedRows = Pick<ReadonlyMap<string, MemoryEntry>, 'get'>;

/** Where a page stopped: the `created`, `id` of its last row, in loadAllEntries' order. */
export interface EntryCursor {
  created: string;
  id: string;
}

export interface EntryPage {
  entries: MemoryEntry[];
  /** The cursor that reads the page after this one, or null when this was the last. */
  next: EntryCursor | null;
}

/** EntryPage with only each row's id. */
export interface EntryIdPage {
  readonly ids: string[];
  readonly next: EntryCursor | null;
}

/** Session decay context: the data needed for session-based and adaptive decay. */
export interface SessionDecayContext {
  /** Total number of sleep (consolidation) cycles completed. */
  sleepCount: number;
  /** Average interval between recent sleep cycles, in days. 0 if < 2 cycles. */
  avgSessionIntervalDays: number;
}

/** Patch applied by applyRebuildResult; `bumpRebuildCount` is false for the zero-child case, true for a normal
 * rebuild. */
export interface RebuildPatch {
  content: string; // new content for normal rebuild; summary.content for zero-child
  descendantCount: number;
  earliestAt: string | null;
  latestAt: string | null;
  bumpRebuildCount: boolean;
  zeroChildren: boolean;
  actor: string;
}

/** What a move is planned from. The object and conflict rows are read only while the typed move is pending. */
export interface HalfLifeRows {
  /** The base the store's memories are on. */
  from: number;
  /** True until the store has moved its object memories off their old flat half-life. */
  typedPending: boolean;
  /** Every row once, by created then id, through one cursor: the plan keeps only what a move needs. */
  rows: Iterable<MemoryEntry>;
  objectRows: Array<{ memory_id: string; status: string }>;
  conflictAudits: Array<{ conflictId: number; loserId: string }>;
  resolvedConflicts: Array<{ id: number; memory_a_id: string; memory_b_id: string }>;
}

/** One memory's half-life before and after a move. */
export interface HalfLifeChange {
  id: string;
  tenantId: string;
  halfLifeDays: number;
  oldHalfLifeDays: number;
}

/** The changes of one move, and the bases their audit rows name. */
export interface HalfLifeMove {
  from: number;
  to: number;
  entries: readonly HalfLifeChange[];
}

/** Tombstone lookups and their refusal audit rows on one handle: opened on first use, never under dryRun, closed
 * once. */
export interface TombstoneChecks {
  /** The tenant's tombstone for `digest`; null when there is none, and always under dryRun. */
  find(tenantId: string, digest: string): RejectedValueRow | null;
  /** One audit row on the same handle; nothing under dryRun. */
  audit(event: AppendAuditOpts): void;
  /** `audit`, with a failed write logged and counted instead of thrown, for a refusal that stands without its row. */
  auditOrCount(event: AppendAuditOpts): void;
  close(): void;
}
