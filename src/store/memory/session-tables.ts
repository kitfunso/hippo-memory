// The in-memory tables behind the session, card, goal, conflict, dormant and token-ledger groups, kept apart from
// tables.ts so each file stays one screen of shapes.
import type { Card, CardComment, CardRun } from '../../base/records/card.js';
import type { SessionHandoffRow } from '../../base/session/handoff.js';
import type { MemoryConflict } from '../port/conflicts.js';
import type { GoalRecallLogRow } from '../port/recall-writes.js';
import type { SessionEvent, TaskSnapshot, WorkingMemoryItem } from '../port/sessions.js';
import type { TokenEvent, TokenSurface } from '../port/ledger.js';
import type { DormantSnapshot, Goal, RetrievalPolicy } from '../port/types.js';

/** A row and the tenant it was written under; `row` is replaced whole on an update. */
export interface Tenanted<R> {
  readonly tenantId: string;
  row: R;
}

/** A row with the continuity key it was saved under, null on an unkeyed write. */
export interface Owned<R> extends Tenanted<R> {
  readonly owner: string | null;
  readonly origin: string | null;
}

interface CardDep {
  readonly tenantId: string;
  readonly parent: string;
  readonly child: string;
}

interface SessionOwner {
  readonly owner: string;
  readonly createdAt: string;
}

export interface TokenRow {
  readonly id: number;
  readonly ts: string;
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly surface: TokenSurface;
  readonly event: TokenEvent;
  readonly items: number;
  readonly tokens: number;
  readonly blockHash: string | null;
}

/** One recall trace: the query's hash and length, never its text. */
interface RecallTrace {
  readonly id: number;
  readonly ts: string;
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly pipeline: string;
  readonly queryHash: string;
  readonly queryLength: number;
  readonly explainMode: boolean;
  readonly results: readonly { readonly memoryId: string; readonly rank: number; readonly score: number }[];
}

export interface SessionTables {
  readonly snapshots: Owned<TaskSnapshot>[];
  readonly events: Tenanted<SessionEvent>[];
  readonly handoffs: Owned<SessionHandoffRow>[];
  workingMemory: Tenanted<WorkingMemoryItem>[];
  /** By tenantKey(tenant, session id). */
  readonly sessionOwners: Map<string, SessionOwner>;
  readonly cards: Map<string, Card>;
  readonly cardDeps: CardDep[];
  readonly cardRuns: Tenanted<CardRun>[];
  readonly cardComments: Tenanted<CardComment>[];
  /** In insertion order, the tie-break order a read falls back to. */
  readonly goals: Goal[];
  readonly policies: Map<string, RetrievalPolicy>;
  readonly goalRecallLog: GoalRecallLogRow[];
  readonly conflicts: MemoryConflict[];
  /** By tenantKey(tenant, memory id), each entry as it reads back from its stored snapshot. */
  readonly dormant: Map<string, DormantSnapshot>;
  tokenLedger: TokenRow[];
  recallTraces: RecallTrace[];
}

export function emptySessionTables(): SessionTables {
  return {
    snapshots: [],
    events: [],
    handoffs: [],
    workingMemory: [],
    sessionOwners: new Map(),
    cards: new Map(),
    cardDeps: [],
    cardRuns: [],
    cardComments: [],
    goals: [],
    policies: new Map(),
    goalRecallLog: [],
    conflicts: [],
    dormant: new Map(),
    tokenLedger: [],
    recallTraces: [],
  };
}
