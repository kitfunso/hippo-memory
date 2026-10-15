// The optional store groups for sessions, cards, goals, conflicts, dormant memories and reports; type-only, apart from
// port.ts so that file stays under the size gate.
import type { Card, CardComment, CardRun, CardStatus } from '../core/card.js';
import type { HandoffOutcome, SessionHandoff } from '../core/handoff.js';
import type { MemoryEntry } from '../core/memory.js';
import type { CardDetail } from './card-detail.js';
import type { StrengthTallies } from './candidates.js';
import type { ResolveConflictOpts, ResolveConflictRequest } from './conflicts.js';
import type { DormantMemory, DormantRestoreOutcome, DormantSnapshot, ListDormantOpts } from './dormant.js';
import type { EntryCursor, EntryPage } from './entry-reads.js';
import type { FailureSummary } from './failure-log.js';
import type { CompleteGoalOpts, Goal, PushGoalOpts } from './goals.js';
import type { HandoffFilter, SessionEndHandoffRequest } from './handoffs.js';
import type { MemoryConflict, SessionEvent, TaskSnapshot } from './rows.js';
import type { ContinuityKey, SessionEventInput, SnapshotInput } from './sessions.js';
import type { TokenSummary } from './token-ledger.js';
import type { JsonObject, WorkingMemoryItem } from './working-memory.js';

export interface WorkingMemoryFilter {
  readonly scope?: string;
  readonly sessionId?: string;
}

export interface WorkingMemoryPush {
  readonly scope: string;
  readonly content: string;
  readonly importance?: number;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly metadata?: JsonObject;
}

/** Snapshots, session events, handoffs, working memory and session-owner binding. Every keyed method takes
 * `key: ContinuityKey | null`, since a group cannot gain members once it ships. */
export interface Sessions {
  saveSnapshot(tenantId: string, snapshot: SnapshotInput, key: ContinuityKey | null): Promise<TaskSnapshot>;
  loadSnapshot(tenantId: string, key: ContinuityKey | null): Promise<TaskSnapshot | null>;
  loadFreshSnapshot(
    tenantId: string,
    opts: { readonly maxAgeMs?: number; readonly sessionId?: string | null },
    key: ContinuityKey | null,
  ): Promise<TaskSnapshot | null>;
  /** True when an active snapshot was cleared. */
  clearSnapshot(tenantId: string, clearedStatus: string): Promise<boolean>;
  /** Rows closed. */
  closeSessionSnapshots(
    tenantId: string,
    sessionId: string,
    status: string,
    key: ContinuityKey | null,
  ): Promise<number>;
  appendEvent(tenantId: string, event: SessionEventInput): Promise<SessionEvent>;
  listEvents(
    tenantId: string,
    opts: { readonly sessionId?: string; readonly task?: string; readonly limit?: number },
  ): Promise<SessionEvent[]>;
  saveHandoff(
    tenantId: string,
    handoff: Omit<SessionHandoff, 'updatedAt'>,
    key: ContinuityKey | null,
  ): Promise<SessionHandoff>;
  latestHandoff(
    tenantId: string,
    sessionId: string | null,
    filter: HandoffFilter,
    key: ContinuityKey | null,
  ): Promise<SessionHandoff | null>;
  handoffById(tenantId: string, id: number): Promise<SessionHandoff | null>;
  /** Rows stamped. */
  stampHandoffOutcome(tenantId: string, sessionId: string, outcome: HandoffOutcome): Promise<number>;
  writeSessionEndHandoff(
    tenantId: string,
    request: Omit<SessionEndHandoffRequest, 'tenantId'>,
  ): Promise<SessionHandoff | null>;
  pushWorkingMemory(tenantId: string, item: WorkingMemoryPush): Promise<number>;
  readWorkingMemory(
    tenantId: string,
    filter: WorkingMemoryFilter & { readonly limit?: number },
  ): Promise<WorkingMemoryItem[]>;
  /** Rows cleared; a session-end flush is the same call. */
  clearWorkingMemory(tenantId: string, filter: WorkingMemoryFilter): Promise<number>;
  /** The stored owner, which is not `owner` when a concurrent first bind won. */
  bindSessionOwner(tenantId: string, sessionId: string, owner: string, retentionMs: number): Promise<string | null>;
}

export interface CardCreate {
  readonly title: string;
  readonly repo?: string;
  readonly contract?: string;
  readonly budget?: number;
  readonly dependsOn?: readonly string[];
}

export interface Cards {
  create(tenantId: string, input: CardCreate): Promise<Card>;
  load(tenantId: string, id: string): Promise<Card | null>;
  /** The card with its runs and comments, read together. */
  detail(tenantId: string, id: string): Promise<CardDetail | null>;
  list(tenantId: string, opts: { readonly status?: CardStatus }): Promise<Card[]>;
  runs(tenantId: string, id: string): Promise<CardRun[]>;
  claim(
    tenantId: string,
    id: string,
    runtime: string,
    sessionId?: string,
  ): Promise<(Card & { runId: number }) | null>;
  heartbeat(tenantId: string, id: string, runId: number): Promise<Card | null>;
  block(tenantId: string, id: string, reason: string, runId?: number): Promise<Card | null>;
  review(tenantId: string, id: string, runId?: number): Promise<Card | null>;
  complete(
    tenantId: string,
    id: string,
    outcome: HandoffOutcome,
    runId?: number,
  ): Promise<{ card: Card; promotedChildren: string[] } | null>;
  /** Ids reclaimed. */
  reclaimExpired(tenantId: string): Promise<string[]>;
  comment(tenantId: string, cardId: string, author: string, body: string): Promise<CardComment>;
}

export interface Goals {
  push(tenantId: string, goal: Omit<PushGoalOpts, 'tenantId'>): Promise<Goal>;
  /** Every status, for `hippo goal list --all`; active-only reads use base `activeGoals`. */
  sessionGoals(tenantId: string, sessionId: string): Promise<Goal[]>;
  /** By id. Goal ids are not tenant-scoped in hippo.db, so the SQLite store ignores `tenantId` and the api keeps the
   * host-admin check; a tenant-keyed store filters on it. */
  complete(tenantId: string, goalId: string, opts: CompleteGoalOpts): Promise<void>;
  suspend(tenantId: string, goalId: string): Promise<void>;
  resume(tenantId: string, goalId: string): Promise<void>;
}

export interface Conflicts {
  /** `tenantId` null reads every tenant (host admin; the api checks). */
  list(tenantId: string | null, status: string): Promise<MemoryConflict[]>;
  /** Conflicts whose both rows the actor may touch; status '*' reads every status. */
  listTouchable(tenantId: string, status: string, actor: { readonly owner?: string }): Promise<MemoryConflict[]>;
  resolve(
    tenantId: string,
    request: Omit<ResolveConflictRequest, 'tenantId'>,
    opts: ResolveConflictOpts,
  ): Promise<{ conflict: MemoryConflict; loserId: string } | null>;
}

export interface DormantRestoreRequest {
  readonly id: string;
  readonly actor: string;
  readonly inReach: (scope: string | null) => boolean;
  readonly revive: (snapshot: DormantSnapshot, now: Date) => MemoryEntry;
}

/** `ownScope` is the caller's personal scope; the store builds its own scope test, so no SQL crosses the port. */
export interface Dormant {
  list(tenantId: string, ownScope: string | null, opts: ListDormantOpts): Promise<DormantMemory[]>;
  holds(tenantId: string, ownScope: string | null, id: string): Promise<boolean>;
  /** `revive` runs inside the store's write, so a throw refuses before any row changes. */
  restore(tenantId: string, request: DormantRestoreRequest): Promise<DormantRestoreOutcome>;
  /** Deletes for good, writes the `forget` audit row and counts it; false when no row in reach. */
  forget(tenantId: string, ownScope: string | null, id: string, actor: string): Promise<boolean>;
}

/** Read-only reports for `hippo status`, `hippo tokens`, `hippo failures` and the listing verbs. */
export interface Reports {
  tokenUse(tenantId: string, sinceIso: string): Promise<TokenSummary>;
  failures(tenantId: string, sinceIso: string): Promise<FailureSummary>;
  /** Strength tallies and the open-conflict count, read on one snapshot. */
  memoryStatus(
    tenantId: string,
    now: Date,
    atRiskBelow: number,
  ): Promise<StrengthTallies & { openConflicts: number }>;
  /** `tenantId` null pages every tenant (host admin; the api checks). */
  entriesPage(
    tenantId: string | null,
    page: { readonly limit: number; readonly after?: EntryCursor },
  ): Promise<EntryPage>;
  /** Every row in the store, no tenant: host admin. */
  countEntries(): Promise<number>;
}

/** The groups StoreGroups gains beyond port.ts, each set whole or left unset. */
export interface SessionAndAdminGroups {
  /** Unset on a store without it; the continuity, session-end and working-memory paths then answer 501. */
  readonly sessions: Sessions;
  /** Unset on a store without it, where the card verbs answer 501. */
  readonly cards: Cards;
  /** Unset on a store without it, where the goal verbs answer 501. */
  readonly goals: Goals;
  /** Unset on a store without it, where conflict listing and resolving answer 501. */
  readonly conflicts: Conflicts;
  /** Unset on a store without it, where the dormant verbs answer 501. */
  readonly dormant: Dormant;
  /** Unset on a store without it, where status, tokens, failures and the memory listings answer 501. */
  readonly reports: Reports;
}
