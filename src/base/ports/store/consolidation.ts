// The store work of one sleep, kept apart from port.ts: reads and writes only, each one call on the
// store. What to decay, merge, promote, rebuild and expire is decided in src/domain/consolidate.
import type { MemoryEntry } from '../../memory/entry.js';
import type { PhysicsParticle } from '../../rank/physics.js';
import type { HalfLifeOutcome } from '../../memory/half-life-plan.js';
import type { AppendAuditOptions, EntryCursor, EntryPage } from './types.js';
import type { RejectedValueRow } from './rejections.js';
import type { SessionEvent } from './sessions.js';
import type { MethodEffects } from './effects.js';

export type {
  HalfLifeChange,
  HalfLifeMove,
  HalfLifeOutcome,
  HalfLifeRow,
  HalfLifeRows,
  ObjectLink,
} from '../../memory/half-life-plan.js';

/** What sleep reads and writes on hippo.db, every tenant at once. */
export interface Consolidation {
  /** A sleep's opening upkeep, each write its own transaction as before: the half-life move to
   * base `to` (nothing under dryRun), then the full-text re-sync (only counted under dryRun);
   * then the reads its passes start from. */
  begin(to: number, opts: SleepBegin): Promise<SleepStart>;
  /** Up to `page.limit` memory ids of every tenant, by created then id, after `page.after`. */
  entryIdsPage(page: {
    readonly limit: number;
    readonly after?: EntryCursor;
  }): Promise<EntryIdPage>;
  /** The tenant's tombstones among `digests`, in their order, in one read however many are
   * asked. */
  rejected(tenantId: string, digests: readonly string[]): Promise<RejectedValueRow[]>;
  /** The memory id of every stored physics particle, in load order. */
  particleIds(): Promise<string[]>;
  /** Writes the particles over their stored state, as one batch. */
  saveParticles(particles: PhysicsParticle[]): Promise<void>;
  /** The `limit` dirty summaries changed last, each with its live children by created then id,
   * and whether more were waiting. */
  dirtySummaries(limit: number): Promise<DirtySummaries>;
  /** Up to `page.limit` of the L2 topic summaries with no L3 profile above them, oldest first,
   * after `page.after`. */
  unprofiledTopicSummaries(page: {
    readonly limit: number;
    readonly after?: EntryCursor;
  }): Promise<EntryPage>;
  /** Lands `settle` on a summary that is still dirty, with its audit rows, in one transaction.
   * New content a tombstone names is kept out, with a refusal row, and the rest still lands. */
  settleSummary(settle: SummarySettle): Promise<SummarySettled>;
  /** The sleep's chunked writes under its own lock wait: the flush, each component whole, in
   * transactions of about `holdMs` with a gap for other writers between them; then the dormant
   * expiry in the same way. */
  commit(commit: SleepCommit): Promise<SleepCommitted>;
  /** Replaces the detected conflicts, appends the run row and adds one to the sleep count, each
   * its own write. */
  recordSleep(record: SleepRecord): Promise<void>;
  /** Appends each row as its own write; a failed row is logged and counted, and the failures
   * returned as a count. */
  auditEachRow(events: readonly AppendAuditOptions[]): Promise<number>;
  /** The current distilled memories that may share a text with another, and the order partitions
   * first appear in. */
  duplicateCandidates(): Promise<DuplicateCandidates>;
  /** Tenants with pending graph work, each with its highest pending queue id. */
  dirtyGraphTenants(): Promise<{ tenantId: string; maxPendingId: number }[]>;
  /** Marks the tenant's pending graph work up to `maxId` processed; returns how many rows it
   * marked. */
  markGraphDrained(tenantId: string, maxId: number): Promise<number>;
}

/** What each Consolidation method does to the store; every adapter honours it. */
export const CONSOLIDATION_EFFECTS = {
  begin: 'write',
  entryIdsPage: 'read',
  rejected: 'read',
  particleIds: 'read',
  saveParticles: 'write',
  dirtySummaries: 'read',
  unprofiledTopicSummaries: 'read',
  settleSummary: 'write',
  commit: 'write',
  recordSleep: 'write',
  auditEachRow: 'write',
  duplicateCandidates: 'read',
  dirtyGraphTenants: 'read',
  markGraphDrained: 'write',
} as const satisfies MethodEffects<Consolidation>;

export interface SleepBegin {
  readonly dryRun: boolean;
  /** Who the half-life move's audit rows name. */
  readonly actor: string;
  /** The tenant whose sessions completed at or after `sinceMs` with no trace yet are read;
   * unset, none are. */
  readonly traces?: { readonly tenantId: string; readonly sinceMs: number };
}

export interface SleepStart {
  /** The base the half-lives were on. */
  readonly from: number;
  /** Null when no move was due. */
  readonly outcome: HalfLifeOutcome | null;
  /** The full-text index's counts when they drifted from `memories`, else null. */
  readonly fts: { readonly memories: number; readonly fts: number } | null;
  /** The stored sleep count, 0 when none was recorded. */
  readonly sleepCount: number;
  /** The newest 20 run times, newest first. */
  readonly recentRuns: readonly string[];
  /** The sessions `traces` asked for, each with its newest events. */
  readonly sessions: readonly UntracedSession[];
}

/** A completed session with no trace yet and its newest TRACE_EVENT_ROWS events, oldest first. */
export interface UntracedSession {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
}

/** EntryPage with only each row's id. */
export interface EntryIdPage {
  readonly ids: string[];
  readonly next: EntryCursor | null;
}

export interface DirtySummaries {
  readonly summaries: ReadonlyArray<{
    readonly summary: MemoryEntry;
    readonly children: MemoryEntry[];
  }>;
  readonly more: boolean;
}

/** The fields one dirty summary settles to; its dirty mark is cleared with them. */
export interface SummarySettle {
  readonly id: string;
  readonly tenantId: string;
  /** Who a refusal row names. */
  readonly actor: string;
  /** The rebuilt fields; unset, only the dirty mark is cleared. */
  readonly fields?: {
    /** New content; the store stamps the rebuild time and adds one to the rebuild count with it. */
    readonly content?: { readonly text: string; readonly rebuiltAt: string };
    readonly descendantCount: number;
    readonly earliestAt: string | null;
    readonly latestAt: string | null;
  };
  /** Appended in order when the row changes, after a refusal row. */
  readonly audit: readonly AppendAuditOptions[];
}

/** `changed` when this call's write hit the row; `refused` when a tombstone kept the new content
 * out. */
export interface SummarySettled {
  readonly changed: boolean;
  readonly refused: boolean;
}

export interface SleepCommit {
  /** The flush, null for none; `snapshot` holds each changed row as sleep loaded it, a Map so it
   * crosses threads. */
  readonly flush: {
    readonly components: readonly FlushComponent[];
    readonly snapshot: ReadonlyMap<string, MemoryEntry>;
  } | null;
  /** Dormant rows moved before this ISO time are deleted for good, or only counted under dryRun;
   * null keeps them. */
  readonly expireBefore: string | null;
  readonly dryRun: boolean;
  /** How long one transaction may hold the write lock; zero commits one component per
   * transaction. */
  readonly holdMs: number;
}

export interface SleepCommitted {
  /** The ids the flush removed from active memory. */
  readonly removedIds: string[];
  /** Dormant memories expired, or that would be under dryRun. */
  readonly expired: number;
}

export interface SleepRecord {
  readonly conflicts: DetectedConflict[];
  /** The run's ISO time: the conflicts' detected time and the run row's. */
  readonly at: string;
  readonly decayed: number;
  readonly merged: number;
  readonly removed: number;
}

export type DetectedConflict = {
  memoryAId: string;
  memoryBId: string;
  reason: string;
  score: number;
};

/** Ops that must commit in one transaction, so a flush split across several never lands part of
 * one. */
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

/** Why a memory went dormant: sleep's decay pass, an imported agent memory whose note was
 * deleted, `hippo projects repair` splitting a two-project merge, or `hippo audit repair`
 * setting aside an automatic memory with a certain defect. */
export type DormantReason = 'decay' | 'source-deleted' | 'project-repair' | 'quality-repair';

/** Each row as the caller loaded it, by id; a `ReadonlyMap` fits. */
export type LoadedRows = Pick<ReadonlyMap<string, MemoryEntry>, 'get'>;

/** Current distilled rows (no raw row, no superseded one) whose text, with all spacing taken
 * out, another such row also has, by created then id; and each (tenant, scope, origin) of every
 * such row in the order it first appears by created then id, so a dedupe over only these rows
 * orders its partitions as a read of every row does. */
export interface DuplicateCandidates {
  rows: MemoryEntry[];
  firstSeen: Array<{ tenantId: string; scope: string | null; originProject: string | null }>;
}
