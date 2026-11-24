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
  begin(to: number, opts: SleepBegin): Promise<SleepStart>;
  entryIdsPage(page: {
    readonly limit: number;
    readonly after?: EntryCursor;
  }): Promise<EntryIdPage>;
  rejected(tenantId: string, digests: readonly string[]): Promise<RejectedValueRow[]>;
  particleIds(): Promise<string[]>;
  particlesByRecall(page: {
    readonly limit: number;
    readonly after?: RecallCursor;
  }): Promise<RecallPage>;
  saveParticles(particles: PhysicsParticle[]): Promise<void>;
  dirtySummaries(limit: number, at?: string): Promise<DirtySummaries>;
  noteRebuildFailures?(
    failed: ReadonlyArray<{
      readonly id: string;
      readonly tenantId: string;
      readonly priorFailures: number;
      readonly failures: number;
      readonly retryAfter: string | null;
    }>,
  ): Promise<void>;
  emptyExtractions?(page: { readonly limit: number; readonly after?: string }): Promise<{
    readonly marks: ReadonlyArray<{
      readonly id: string;
      readonly digest: string;
      readonly at: string;
    }>;
    readonly next: string | null;
  }>;
  noteEmptyExtractions?(note: {
    readonly mark: ReadonlyArray<{
      readonly id: string;
      readonly digest: string;
      readonly at: string;
    }>;
    readonly clear: readonly string[];
  }): Promise<void>;
  unprofiledTopicSummaries(page: {
    readonly limit: number;
    readonly after?: EntryCursor;
  }): Promise<EntryPage>;
  settleSummary(settle: SummarySettle): Promise<SummarySettled>;
  commit(commit: SleepCommit): Promise<SleepCommitted>;
  recordSleep(record: SleepRecord): Promise<void>;
  auditEachRow(events: readonly AppendAuditOptions[]): Promise<number>;
  duplicateCandidates(): Promise<DuplicateCandidates>;
  dirtyGraphTenants(): Promise<{ tenantId: string; maxPendingId: number }[]>;
  markGraphDrained(tenantId: string, maxId: number): Promise<number>;
  claimSleep?(): Promise<SleepClaim>;
  releaseSleep?(): Promise<void>;
}

/** The answer to `claimSleep`: `since` is the ISO time the holder took it. */
export type SleepClaim =
  | { readonly kind: 'taken' }
  | { readonly kind: 'held'; readonly since: string };

/** What each Consolidation method does to the store; every adapter honours it. */
export const CONSOLIDATION_EFFECTS = {
  begin: 'write',
  entryIdsPage: 'read',
  rejected: 'read',
  particleIds: 'read',
  particlesByRecall: 'read',
  saveParticles: 'write',
  dirtySummaries: 'read',
  noteRebuildFailures: 'write',
  emptyExtractions: 'read',
  noteEmptyExtractions: 'write',
  unprofiledTopicSummaries: 'read',
  settleSummary: 'write',
  commit: 'write',
  recordSleep: 'write',
  auditEachRow: 'write',
  duplicateCandidates: 'read',
  dirtyGraphTenants: 'read',
  markGraphDrained: 'write',
  claimSleep: 'write',
  releaseSleep: 'write',
} as const satisfies MethodEffects<Consolidation>;

export interface SleepBegin {
  readonly dryRun: boolean;
  readonly actor: string;
  readonly traces?: { readonly tenantId: string; readonly sinceMs: number };
}

export interface SleepStart {
  readonly from: number;
  readonly outcome: HalfLifeOutcome | null;
  readonly fts: { readonly memories: number; readonly fts: number } | null;
  readonly sleepCount: number;
  readonly recentRuns: readonly string[];
  readonly sessions: readonly UntracedSession[];
}

/** A completed session with no trace yet and its newest TRACE_EVENT_ROWS events, oldest first. */
export interface UntracedSession {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
}

/** Where a page in recall order starts: after this row. Recall order is last recalled first,
 * then the row stored last first, so `rowid` breaks ties. */
export interface RecallCursor {
  readonly lastRetrieved: string;
  readonly rowid: number;
}

export interface RecalledMemory {
  readonly id: string;
  readonly lastRetrieved: string;
}

export interface RecallPage {
  readonly memories: RecalledMemory[];
  readonly next: RecallCursor | null;
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
    readonly failures?: number;
  }>;
  readonly more: boolean;
  readonly held?: number;
}

/** The fields one dirty summary settles to; its dirty mark is cleared with them. */
export interface SummarySettle {
  readonly id: string;
  readonly tenantId: string;
  readonly actor: string;
  readonly fields?: {
    readonly content?: { readonly text: string; readonly rebuiltAt: string };
    readonly descendantCount: number;
    readonly earliestAt: string | null;
    readonly latestAt: string | null;
  };
  readonly audit: readonly AppendAuditOptions[];
}

/** `changed` when this call's write hit the row; `refused` when a tombstone kept the new content
 * out. */
export interface SummarySettled {
  readonly changed: boolean;
  readonly refused: boolean;
}

export interface SleepCommit {
  readonly flush: {
    readonly components: readonly FlushComponent[];
    readonly snapshot: ReadonlyMap<string, MemoryEntry>;
  } | null;
  readonly expireBefore: string | null;
  readonly dryRun: boolean;
  readonly holdMs: number;
}

export interface SleepCommitted {
  readonly removedIds: string[];
  readonly expired: number;
}

export interface SleepRecord {
  readonly conflicts: DetectedConflict[];
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
  entry: MemoryEntry;
  strength: number;
  reason: DormantReason;
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
