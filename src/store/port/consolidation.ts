// The store work of one sleep, kept apart from port.ts. Each method is one call on the store; the two chunked writers
// commit a transaction per chunk and pace the chunks with the store's own clock.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';
import type { HalfLifeOutcome } from '../../base/memory/half-life-plan.js';
import type { SessionEvent } from './sessions.js';
import type { AppendAuditOpts, EntryCursor, EntryPage } from './types.js';
import type { RejectedValueRow } from './rejections.js';

export type {
  HalfLifeChange,
  HalfLifeMove,
  HalfLifeOutcome,
  HalfLifeRow,
  HalfLifeRows,
  ObjectLink,
} from '../../base/memory/half-life-plan.js';

/** What sleep reads and writes on hippo.db, every tenant at once. */
export interface Consolidation {
  /** Up to `page.limit` memory ids of every tenant, by created then id, after `page.after`. */
  entryIdsPage(page: { readonly limit: number; readonly after?: EntryCursor }): Promise<EntryIdPage>;
  /** The rows for `ids` by id; an id deleted since it was listed is absent. */
  entriesByIds(ids: readonly string[]): Promise<Map<string, MemoryEntry>>;
  /** The ids among `ids` that a typed object row names; sleep never retires one. */
  objectBackedAmong(ids: readonly string[]): Promise<Set<string>>;
  /** The full-text index counts when they drift from `memories` (re-synced when `repair`), else null. */
  ftsDrift(repair: boolean): Promise<{ memories: number; fts: number } | null>;
  /** The sleep count and the average interval between recent sleeps. */
  sessionDecayContext(): Promise<SessionDecayContext>;
  /** The tenant's tombstone for `digest`, or null when it has none. */
  rejectedValue(tenantId: string, digest: string): Promise<RejectedValueRow | null>;
  /** The digests among `digests` the tenant holds a tombstone for, in one read however many are asked. */
  rejectedDigests(tenantId: string, digests: readonly string[]): Promise<Set<string>>;
  /** The default half-life base the memories are on. */
  halfLifeBase(): Promise<number>;
  /** Plans the moves to base `to` from one read of the rows and writes them, their audit rows and the new base in that
   * one transaction (nothing under dryRun); `outcome` is null when no move is due. */
  moveHalfLives(
    to: number,
    opts: { dryRun: boolean; actor: string },
  ): Promise<{ from: number; outcome: HalfLifeOutcome | null }>;
  /** The tenant's sessions completed since `sinceMs`. */
  promotableSessions(tenantId: string, sinceMs: number): Promise<Array<{ session_id: string }>>;
  /** True when the tenant already holds a trace for the session. */
  traceExists(tenantId: string, sessionId: string): Promise<boolean>;
  /** The tenant's session events, filtered as `listSessionEvents` filters them. */
  sessionEvents(tenantId: string, opts: { session_id?: string; limit?: number }): Promise<SessionEvent[]>;
  /** The memory id of every stored physics particle, in load order. */
  particleIds(): Promise<string[]>;
  /** The stored particles for `ids`, in that order; an id with no particle is skipped. */
  particlesByIds(ids: readonly string[]): Promise<PhysicsParticle[]>;
  /** Writes the particles over their stored state, as one batch. */
  saveParticles(particles: PhysicsParticle[]): Promise<void>;
  /** Commits each component whole, in transactions of about `holdMs` with a gap for other writers between them, under
   * sleep's own lock wait; resolves to the ids it removed. A zero hold commits one component per transaction. */
  commitFlush(
    components: readonly FlushComponent[],
    opts: { snapshot: ReadonlyMap<string, MemoryEntry>; holdMs: number },
  ): Promise<string[]>;
  /** Counts (dryRun) or deletes the dormant memories moved before `cutoffIso`, in transactions of about `holdMs`, under
   * sleep's own lock wait. */
  expireDormant(cutoffIso: string, opts: { dryRun: boolean; holdMs: number }): Promise<number>;
  /** Replaces the detected conflicts with these. */
  replaceConflicts(detected: DetectedConflict[], detectedAt: string): Promise<void>;
  /** Appends one consolidation-run row. */
  recordRun(run: { timestamp: string; decayed: number; merged: number; removed: number }): Promise<void>;
  /** Adds one to the store's sleep count. */
  countSleep(): Promise<void>;
  /** Appends each row as its own write; a failed row is logged and counted, and the failures returned as a count. */
  auditEachRow(events: readonly AppendAuditOpts[]): Promise<number>;
  /** Up to `limit` memories of every tenant after `after`, by created then id, so a pass holds one page at a time. */
  entriesPage(page: { readonly limit: number; readonly after?: EntryCursor }): Promise<EntryPage>;
  /** The current distilled memories that may share a text with another, and the order partitions first appear in. */
  duplicateCandidates(): Promise<DuplicateCandidates>;
  /** Deletes the targets, one transaction per chunk, each with its own forget row; true where the row went. */
  deleteInBatches(
    targets: readonly { id: string; reason: string }[],
    opts: { actor?: string; automatic?: boolean },
  ): Promise<boolean[]>;
  /** Tenants with pending graph work, each with its highest pending queue id. */
  dirtyGraphTenants(): Promise<{ tenantId: string; maxPendingId: number }[]>;
  /** Marks the tenant's pending graph work up to `maxId` processed; returns how many rows it marked. */
  markGraphDrained(tenantId: string, maxId: number): Promise<number>;
  /** Up to `limit` summaries marked dirty. */
  dirtySummaries(limit: number): Promise<MemoryEntry[]>;
  /** The current children of one summary. */
  childrenOfSummary(summaryId: string, tenantId: string): Promise<MemoryEntry[]>;
  /** One read of the children of every summary given: one list per summary, in the order given. */
  childrenOfSummaries(summaries: ReadonlyArray<{ id: string; tenantId: string }>): Promise<MemoryEntry[][]>;
  /** Applies a rebuilt summary while it is still dirty; `refused` when its new content is tombstoned. */
  applyRebuild(summary: MemoryEntry, patch: RebuildPatch): Promise<{ changed: boolean; refused: boolean }>;
  /** Clears the dirty mark a fresh summary got from its own child links. */
  clearSummaryDirty(summaryId: string, tenantId: string, actor: string, source?: string): Promise<void>;
  /** The L2 topic summaries with no L3 profile above them. */
  unprofiledTopicSummaries(): Promise<MemoryEntry[]>;
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

/**
 * Patch applied by applyRebuildResult; `bumpRebuildCount` is false for the zero-child case, true for a normal rebuild.
 */
export interface RebuildPatch {
  content: string; // new content for normal rebuild; summary.content for zero-child
  descendantCount: number;
  earliestAt: string | null;
  latestAt: string | null;
  bumpRebuildCount: boolean;
  zeroChildren: boolean;
  actor: string;
}

/** Current distilled rows (no raw row, no superseded one) whose text, with all spacing taken out, another such row
 * also has, by created then id; and each (tenant, scope, origin) of every such row in the order it first appears by
 * created then id, so a dedupe over only these rows orders its partitions as a read of every row does. */
export interface DuplicateCandidates {
  rows: MemoryEntry[];
  firstSeen: Array<{ tenantId: string; scope: string | null; originProject: string | null }>;
}
