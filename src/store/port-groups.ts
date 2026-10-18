// The store groups for sessions, cards, goals, conflicts, dormant memories and reports; type-only, apart from
// port.ts so that file stays under the size gate.
import type { Card, CardComment, CardRun, CardStatus } from '../core/card.js';
import type { HandoffOutcome, SessionHandoff } from '../core/handoff.js';
import type { MemoryEntry } from '../core/memory.js';
import type { TenantId } from '../util/tenant.js';
import type { CardDetail } from './port/cards.js';
import type { StatusCounts, StrengthTallies } from './port/reports.js';
import type { DormantMemory, DormantRestoreOutcome, ListDormantOpts } from './port/dormant.js';
import type { FailureSummary } from './port/failure-log.js';
import type { CompleteGoalOpts, PushGoalOpts } from './port/goals.js';
import type { HandoffFilter, SessionEndHandoffRequest } from './port/sessions.js';
import type { FailureLog } from './port/failure-log.js';
import type { Compactions } from './port/compactions.js';
import type { Rejections } from './port/rejections.js';
import type { ConflictListQuery, ConflictResolution, ConflictRow, ConflictRowPage } from './port/conflicts.js';
import type { LegacyStats } from './port/reports.js';
import type { SessionEvent, TaskSnapshot } from './port/sessions.js';
import type { SessionEventInput, SnapshotInput } from './port/sessions.js';
import type { TokenSummary } from './port/token-ledger.js';
import type { WorkingMemoryItem } from './port/sessions.js';
import type { DormantSnapshot } from './port/agent-import.js';
import type { EntryCursor, EntryPage } from './port/consolidation.js';
import type { Goal, ContinuityKey, JsonObject } from './port/types.js';

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
  claim(tenantId: string, id: string, runtime: string, sessionId?: string): Promise<(Card & { runId: number }) | null>;
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
  /** By id. Goal ids are not tenant-scoped in hippo.db, so that store ignores `tenantId` and the api keeps the
   * host-admin check; a tenant-keyed store filters on it. */
  complete(tenantId: string, goalId: string, opts: CompleteGoalOpts): Promise<void>;
  suspend(tenantId: string, goalId: string): Promise<void>;
  resume(tenantId: string, goalId: string): Promise<void>;
}

export interface Conflicts {
  /** One page, newest change first, each conflict with both members' columns from the same read. */
  list(query: ConflictListQuery): Promise<ConflictRowPage>;
  /** Conflict `conflictId`, any status, when both its members are in the tenant; else null. */
  get(tenantId: string, conflictId: number): Promise<ConflictRow | null>;
  /** Writes what the api decided, in one transaction, while the conflict is still open and each side still holds the
   * scope in `resolution`; false, with nothing written, otherwise. */
  resolve(tenantId: string, resolution: ConflictResolution): Promise<boolean>;
}

export interface DormantRestoreRequest {
  readonly id: string;
  readonly actor: string;
  readonly inReach: (scope: string | null) => boolean;
  readonly revive: (snapshot: DormantSnapshot, now: Date) => MemoryEntry;
}

/** `ownScope` is the caller's personal scope; the store builds its own scope test, so no predicate crosses the port. */
export interface Dormant {
  list(tenantId: string, ownScope: string | null, opts: ListDormantOpts): Promise<DormantMemory[]>;
  holds(tenantId: string, ownScope: string | null, id: string): Promise<boolean>;
  /** `revive` runs inside the store's write, so a throw refuses before any row changes; its entry's origin is filled
   * as writeEntry fills one. */
  restore(tenantId: string, request: DormantRestoreRequest): Promise<DormantRestoreOutcome>;
  /** Deletes for good, writes the `forget` audit row and counts it; false when no row in reach. */
  forget(tenantId: string, ownScope: string | null, id: string, actor: string): Promise<boolean>;
}

/** Read-only reports for `hippo status`, `hippo tokens`, `hippo failures` and the listing verbs. */
export interface Reports {
  tokenUse(tenantId: string, sinceIso: string): Promise<TokenSummary>;
  failures(tenantId: string, sinceIso: string): Promise<FailureSummary>;
  /** Strength tallies and the open-conflict count, read on one snapshot. */
  memoryStatus(tenantId: string, now: Date, atRiskBelow: number): Promise<StrengthTallies & { openConflicts: number }>;
  /** ALL_TENANTS pages every tenant (host admin; the api checks). */
  entriesPage(tenantId: TenantId, page: { readonly limit: number; readonly after?: EntryCursor }): Promise<EntryPage>;
  /** Every row in the store, no tenant: host admin. */
  countEntries(): Promise<number>;
  /** The store's lifetime counters and its recent sleep runs: host admin. */
  stats(): Promise<LegacyStats>;
  /** What `hippo status` counts over every row of every tenant, superseded ones too: host admin. */
  statusCounts(now: Date, atRiskBelow: number): Promise<StatusCounts>;
  /** Every superseded row, its successor and that row's extraction source, by created then id: host admin. */
  correctionEntries(): Promise<MemoryEntry[]>;
  /** Every kind='raw' row, by created then id: host admin. */
  rawEntries(): Promise<MemoryEntry[]>;
  /** Rows the tenant created since the last sleep of the store, looking back at most a day from `now`. */
  createdSinceLastSleep(tenantId: string, now: Date): Promise<number>;
}

/** The groups StoreGroups gains beyond port.ts, each required and set whole. */
export interface SessionAndAdminGroups {
  /** The continuity, session-end and working-memory paths. */
  readonly sessions: Sessions;
  readonly cards: Cards;
  readonly goals: Goals;
  /** Conflict listing and resolving. */
  readonly conflicts: Conflicts;
  readonly dormant: Dormant;
  /** Status, tokens, failures and the memory listings. */
  readonly reports: Reports;
  readonly rejections: Rejections;
  readonly failureLog: FailureLog;
  readonly compactions: Compactions;
}
