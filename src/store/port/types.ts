// Port types that two or more groups, or the store itself, share.
import type { AuditOp } from '../../base/records/audit-ops.js';
import type { JsonObject } from '../../base/util/json.js';
import type { MemoryEntry } from '../../base/memory/memory.js';

/** One api_keys row and its scope grants as a store returns it, revoked or not; the core checks the secret, the role
 * and the expiry. */
export interface ApiKeyRecord {
  keyHash: string;
  tenantId: string;
  revokedAt: string | null;
  role: string;
  scopes: string[];
  /** ISO time the key stops working; null when it never expires. */
  expiresAt: string | null;
  /** Who minted the key; optional because a store that omits it fails safe to an unowned key. */
  ownerSubject?: string | null;
}

/** A session's active goals, oldest first, and the retrieval policy of each goal that names one. */
export interface ActiveGoals {
  readonly goals: Goal[];
  readonly policies: ReadonlyMap<string, RetrievalPolicy>;
}

export interface Goal {
  id: string;
  sessionId: string;
  tenantId: string;
  goalName: string;
  level: number;
  parentGoalId?: string;
  status: GoalStatus;
  successCondition?: string;
  retrievalPolicyId?: string;
  createdAt: string;
  completedAt?: string;
  outcomeScore?: number;
}

export type GoalStatus = 'active' | 'suspended' | 'completed';

export interface RetrievalPolicy {
  id: string;
  goalId: string;
  policyType: PolicyType;
  weightSchemaFit: number;
  weightRecency: number;
  weightOutcome: number;
  errorPriority: number;
}

export type PolicyType = 'schema-fit-biased' | 'error-prioritized' | 'recency-first' | 'hybrid';

export interface GetActiveGoalsOpts {
  sessionId: string;
  tenantId: string;
}

/** A shared-store caller's task state bucket: its owner and every name its project's rows carry. */
export interface ContinuityKey {
  readonly owner: string;
  readonly project: readonly string[];
}

/** The prediction class a forward claim resolves to, and that class's closed-prediction stats when one resolved. */
export interface PlanningFallacyEvidence extends ClassResolution {
  readonly baserate: PredictionBaserate | null;
}

export interface ClassResolution {
  classTag: string | null;
  /** True when >=2 classes tied at the best overlap score AND best >= 1. Caller emits `recall_autodebias_hint_tiebreak`
   * and returns a null hint (silent: an alphabetical tiebreak would show the wrong class half the time). */
  tiebreak: boolean;
}

export interface PredictionBaserate {
  classTag: string;
  /**
   * Count of closed predictions with a numeric actual_value (excludes open + closed-unknown). The denominator for MAE.
   */
  nClosed: number;
  /** Count of closed rows where estimate_value > 0 (i.e. ratio is defined).
   *  Subset of nClosed used for meanRatio + p50Ratio. */
  nRatioEligible: number;
  meanEstimate: number | null;
  meanActual: number | null;
  /** mean(actual / estimate) over the nRatioEligible subset. Null when nRatioEligible = 0 (e.g. all closed predictions
   *  had estimate=0). */
  meanRatio: number | null;
  /** Median ratio over the nRatioEligible subset. */
  p50Ratio: number | null;
  /** Mean absolute error = mean(|actual - estimate|) over the nClosed set. */
  mae: number | null;
  /** Human-readable summary string for direct surface in CLI / MCP / HTTP.
   *  Empty when nClosed = 0. */
  summary: string;
}

export interface AppendAuditOpts {
  tenantId: string;
  actor: string; // 'cli' | 'api_key:hk_...' | 'system'
  op: AuditOp;
  targetId?: string;
  // Opaque on purpose: appendAuditEvent only JSON.stringify's it wholesale and never reads a field, so no parsed
  // contract is claimed.
  metadata?: unknown;
}

export interface AuditEvent {
  id: number;
  ts: string;
  tenantId: string;
  actor: string;
  op: AuditOp;
  targetId: string | null;
  metadata: JsonObject;
}

export type HeldText = Pick<MemoryEntry, 'content' | 'source' | 'originProject'>;

/** One project name, or every name a project's rows carry. */
export type OriginFilter = string | readonly string[];

/** The api_keys fields a tenant, revocation, rank or self-service ownership check reads. */
export interface ApiKeyOwner {
  tenantId: string;
  revokedAt: string | null;
  role: string;
  ownerSubject: string | null;
}

/** A dormant memory's stored snapshot plus when and why it went dormant. */
export interface DormantSnapshot {
  entry: MemoryEntry;
  reason: string;
  strength: number;
  dormantAt: string;
}

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
