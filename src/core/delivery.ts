// The delivery event a store writes: the shape of one row the ledger group books, and the two facts about it the
// recorder and the store share.

export type DeliveryRuntime = 'claude-code' | 'codex' | 'copilot' | 'unknown';

export type DeliveryEventType =
  | 'prompt-submit'
  | 'pinned-manual'
  | 'pre-compact'
  | 'compact-resume'
  | 'session-end'
  | 'context'
  | 'tool-failure';

export type DeliverySurface = 'hook' | 'context';

export type DeliveryWriteStore = 'local' | 'global';

export type DeliverySessionState = 'payload' | 'env' | 'missing' | 'subagent';

export type DeliveryBlockState = 'sent' | 'reused' | 'reused-recall-sent' | 'empty' | 'disabled';

export type DeliveryPool = 'pin' | 'recent' | 'prompt-recall' | 'strength' | 'search';

export type DeliveryStage = 'load' | 'eligible' | 'gate' | 'budget' | 'limit' | 'final';

export type DeliveryOutcome = 'emitted' | 'reused' | 'rejected';

export type DeliveryRejectReason =
  | 'budget'
  | 'gate-below-threshold'
  | 'gate-max-items'
  | 'duplicate'
  | 'scope'
  | 'quality'
  | 'limit';

export interface DeliveryCandidateInput {
  memoryId: string;
  sourceStore: DeliveryWriteStore;
  pool: DeliveryPool;
  stage: DeliveryStage;
  outcome: DeliveryOutcome;
  reason: DeliveryRejectReason | null;
  rank: number | null;
  score: number | null;
  tokens: number | null;
}

/** One event as the writer stores it; the writer adds `turn_seq`, `duplicate_of` and the format version. */
export interface DeliveryEventInput {
  ts: string;
  tenantId: string;
  runtime: DeliveryRuntime;
  eventType: DeliveryEventType;
  surface: DeliverySurface;
  storeHash: string;
  writeStore: DeliveryWriteStore;
  projectHash: string | null;
  sessionId: string | null;
  sessionState: DeliverySessionState;
  hostTurnId: string | null;
  promptHash: string | null;
  promptLength: number;
  queryHash: string | null;
  recallTraceId: number | null;
  blockState: DeliveryBlockState;
  promptRecall: boolean;
  consideredCount: number;
  filteredCount: number;
  selectedCount: number;
  emittedCount: number;
  rejectedCount: number;
  rejectedUnlisted: number;
  sectionsShown: number;
  sectionsDropped: number;
  budgetTokens: number;
  selectedTokens: number;
  injectedTokens: number;
  staticHash: string | null;
  recallHash: string | null;
  emittedHash: string | null;
  elapsedMs: number;
  /** The host's id for the tool call; set on `tool-failure` rows only. */
  toolUseId?: string | null;
  /** The `failure_log` row the failure was logged as; set on `tool-failure` rows only. */
  failureId?: number | null;
  candidates: readonly DeliveryCandidateInput[];
}

/** True for the boundary types: a compaction's two hooks and the end of a session. */
export const isBoundaryEvent = (type: DeliveryEventType): boolean =>
  type === 'pre-compact' || type === 'compact-resume' || type === 'session-end';

/** Row format version in `delivery_events.ledger_version`: 4 = written by a binary that can write `tool-failure` rows
 * and hashes the store's resolved root. */
export const DELIVERY_LEDGER_VERSION = 4;
