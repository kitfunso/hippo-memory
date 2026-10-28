// Recall composition: from the loaded candidates and the plan's reads to the reply and its rows;
// touches no store. The bands are placed in bands.ts.
import { estimateTokens } from '../../base/util/token-text.js';
import { refuseSecretKeys } from '../../base/errors/secret-keys.js';
import { formatHandoffEvidenceLine } from '../../base/session/handoff.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { GoalStackBoostOptions } from '../../domain/search/goal-boost.js';
import type { ForwardClaimMatch } from '../../domain/learn/forward-claim-detector.js';
import type { RecallWrites } from '../../base/ports/store.js';
import { churnStaleFactor } from '../../domain/search/boosts.js';
import { projectNames } from '../../base/scope/project-identity.js';
import {
  autodebiasMode,
  decidePlanningFallacy,
  detectPlanningClaim,
  type PlanningFallacyDecision,
} from '../../domain/predictions/planning-fallacy.js';
import { detectAvailabilityBias, type AvailabilityHint } from '../availability.js';
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import type {
  RecallSuppressionSummary,
  RecallOptions,
  RecallResult,
  RecallResultItem,
  ContinuityBlock,
} from './types.js';
import type { Context } from '../types.js';
import type { RecallProfile } from './profiles.js';
import {
  anchoringRows,
  availabilityRows,
  callerOf,
  recallAuditMetadata,
  recallAuditRow,
} from './finish.js';
import {
  biasHintEnabled,
  detectAnchoring,
  hashQueryText,
  type AnchoringHint,
} from './anchoring.js';
import type { ActiveGoals, PlanningFallacyEvidence } from '../../base/ports/store/types.js';
import type { RecallTraceInput } from '../../base/ports/store/recall-writes.js';
import { type RankedBands, rankBands, overflowGroups } from './bands.js';

const DEFAULT_RECALL_LIMIT = 10;

export function recallOrigin(opts: RecallOptions): readonly string[] | undefined {
  const project = opts.filter?.project;
  return project ? projectNames(project) : undefined;
}

/** The scope-admitted candidates in churn order, and the top `limit` of them. */
export interface CandidateWindow {
  entries: MemoryEntry[];
  baseSlice: MemoryEntry[];
  droppedPreRank: number;
  droppedByBudget: number;
}

/** What a recall reads once its candidates are known, worked out first so the reads can go to
 * hippo.db or the port. */
export interface RecallPlan {
  limit: number;
  window: CandidateWindow;
  /** The caller's personal scope, from the authenticated actor. */
  personalScope: string | undefined;
  /** Set when a session and no explicit goal tag ask for the goal-stack boost. */
  goalBoost: GoalStackBoostOptions | null;
  /** Overflowed children by summary parent, for the parents that may stand in for them; read
   * only when not empty. */
  overflow: Map<string, MemoryEntry[]>;
  claim: ForwardClaimMatch | null;
}

/** The rows a plan asked for; each is empty or null when the plan did not ask. */
export interface RecallReads {
  goals: ActiveGoals | null;
  parents: MemoryEntry[];
  freshRaws: MemoryEntry[];
  continuity: ContinuityBlock | undefined;
  planning: PlanningFallacyEvidence | null;
}

interface AnchoringOutcome {
  anchoringHint: AnchoringHint | null;
  suppressedByInterference: number;
}

/** The reply, and the rows the store writes once it is composed. */
export interface ComposedRecall {
  result: RecallResult;
  writes: RecallWrites;
}

export interface PlanRecallOptions {
  readonly opts: RecallOptions;
  readonly all: MemoryEntry[];
  readonly personalScope: string | undefined;
  readonly profile: RecallProfile;
}

export function planRecall(
  ctx: Context,
  { opts, all, personalScope, profile }: PlanRecallOptions,
): RecallPlan {
  refuseSecretKeys({ sessionId: opts.boost?.sessionId });
  const limit = opts.window?.limit ?? DEFAULT_RECALL_LIMIT;
  const window = admitCandidates(opts, all, limit, personalScope);
  const { sessionId, goalTag } = opts.boost ?? {};
  return {
    limit,
    window,
    personalScope,
    goalBoost:
      profile.goalBoost.band && sessionId && !goalTag
        ? { sessionId, tenantId: ctx.tenantId, limit, now: ctx.infra.clock() }
        : null,
    overflow:
      (opts.window?.summarizeOverflow ?? true) && window.entries.length > limit
        ? overflowGroups(window, limit)
        : new Map(),
    claim: detectPlanningClaim(opts.query, { mode: autodebiasMode(ctx.config.runtime) }),
  };
}

/** The reply and the rows it writes, from the candidates and the plan's reads; touches no store.
 *  `auditWindow` false: the caller shows a cut of the window and audits the rows it shows. */
interface ComposeRecallOptions {
  readonly windowSize: number;
  readonly all: MemoryEntry[];
  readonly plan: RecallPlan;
  readonly reads: RecallReads;
  readonly auditWindow?: boolean;
}

export function composeRecall(
  ctx: Context,
  opts: RecallOptions,
  options: ComposeRecallOptions,
): ComposedRecall {
  const { plan, reads, auditWindow = true } = options;
  const { window } = plan;
  const bands = rankBands(opts, plan, reads);
  const rankedOut = bands.rankedOut;
  const continuity = reads.continuity
    ? scopeContinuity(reads.continuity, opts.filter?.scope, plan.personalScope)
    : undefined;
  const planning = planningDecision(ctx, plan, reads);
  const { anchoringHint, suppressedByInterference } = detectRecallAnchoring(
    ctx,
    opts,
    rankedOut[0]?.id ?? null,
  );
  const availabilityHint = detectRecallAvailability(ctx, opts, bands.baseSlice, window.entries);

  const result = recallResult(options, bands, continuity, suppressedByInterference);
  // The hint and the no-class-match / tiebreak watching variant are mutually exclusive; both go out
  // as optional fields.
  if (planning?.output.hint) result.planningFallacyHint = planning.output.hint;
  if (planning?.output.watching) result.planningFallacyWatching = planning.output.watching;
  if (anchoringHint) result.anchoringHint = anchoringHint;
  if (availabilityHint) result.availabilityHint = availabilityHint;

  const who = callerOf(ctx);
  const audit = auditWindow
    ? [recallAuditRow(who, 'recall', undefined, recallAuditMetadata(opts.query, rankedOut.length))]
    : [];
  if (planning?.audit) audit.push(planning.audit);
  audit.push(...anchoringRows(who, anchoringHint), ...availabilityRows(who, availabilityHint));
  return {
    result,
    writes: { goalLog: bands.goalLog, audit, trace: recallTrace(ctx, opts, rankedOut) },
  };
}

// Query-derived, so MCP and CLI read this one hint instead of recomputing; HIPPO_AUTODEBIAS=off
// disables it.
function planningDecision(
  ctx: Context,
  plan: RecallPlan,
  reads: RecallReads,
): PlanningFallacyDecision | null {
  return plan.claim && reads.planning
    ? decidePlanningFallacy(plan.claim, reads.planning, ctx.tenantId, ctx.actor.subject)
    : null;
}

function recallResult(
  options: ComposeRecallOptions,
  bands: RankedBands,
  continuity: ContinuityBlock | undefined,
  suppressedByInterference: number,
): RecallResult {
  const { windowSize, all, plan } = options;
  const { window } = plan;
  const { rankedOut } = bands;
  return {
    results: rankedOut,
    total: window.entries.length,
    tokens: rankedOut.reduce((acc, r) => acc + estimateTokens(r.content), 0),
    continuity,
    continuityTokens: continuity ? continuityTokensOf(continuity) : undefined,
    windowSize,
    suppressionSummary: {
      totalCandidates: all.length,
      droppedPreRank: window.droppedPreRank + bands.heldDropped,
      droppedByBudget: window.droppedByBudget,
      summarySubstitutionsAdded: bands.summarySubstitutions,
      freshTailAdded: bands.freshTailAdded,
      suppressedByInterference,
    } satisfies RecallSuppressionSummary,
  };
}

// The SQL load already applied tenant and scope; a recall candidate loader must go through
// store.searchRecallEntries.
function admitCandidates(
  opts: RecallOptions,
  all: MemoryEntry[],
  limit: number,
  personalScope: string | undefined,
): CandidateWindow {
  const current = all.filter((e) => !e.supersededBy);
  const scope = opts.filter?.scope;
  let entries: typeof all;
  if (scope !== undefined && scope !== '') {
    // SQL already exact-matched; the JS filter is defense-in-depth against a SQL-clause regression.
    entries = current.filter((e) => e.scope === scope);
  } else {
    // SQL pre-filtered ':private:' loosely before the window; this is the exact anchored
    // `<source>:private:*` rule.
    entries = current.filter((e) =>
      passesScopeFilterForRecall(e.scope ?? null, undefined, personalScope),
    );
  }
  const droppedPreRank = all.length - entries.length;
  entries = entries
    .map((e, i) => ({ e, s: (1 - i / entries.length) * churnStaleFactor(e) }))
    .sort((a, b) => b.s - a.s)
    .map((r) => r.e);
  // BM25 ordering already comes from store.searchRecallEntries; cap to `limit`.
  const baseSlice = entries.slice(0, limit);
  return { entries, baseSlice, droppedPreRank, droppedByBudget: entries.length - baseSlice.length };
}

// The trace is observability, not retrieval state; a caller that traces its own result set
// suppresses it.
function recallTrace(
  ctx: Context,
  opts: RecallOptions,
  rankedOut: RecallResultItem[],
): RecallTraceInput | undefined {
  if (opts.trace?.suppressRecallTrace) return undefined;
  return {
    tenantId: ctx.tenantId,
    sessionId: opts.boost?.sessionId ?? null,
    pipeline: 'api',
    query: opts.query,
    explainMode: opts.trace?.explain === true,
    results: rankedOut.map((r) => ({
      memoryId: r.id,
      score: r.score,
      rerankSteps: r.rerankTrace,
    })),
  };
}

// The memory-recall scope rule: an explicit scope must match exactly; without one, private and
// legacy rows are denied.
function scopeContinuity(
  block: ContinuityBlock,
  scope: string | undefined,
  personalScope: string | undefined,
): ContinuityBlock {
  const rowScope = (r: { scope?: string | null } | null | undefined): string | null =>
    r?.scope ?? null;
  const { activeSnapshot: snapshot, sessionHandoff } = block;
  return {
    activeSnapshot:
      snapshot && passesScopeFilterForRecall(rowScope(snapshot), scope, personalScope)
        ? snapshot
        : null,
    sessionHandoff:
      sessionHandoff && passesScopeFilterForRecall(rowScope(sessionHandoff), scope, personalScope)
        ? sessionHandoff
        : null,
    recentSessionEvents: block.recentSessionEvents.filter((e) =>
      passesScopeFilterForRecall(rowScope(e), scope, personalScope),
    ),
  };
}

function continuityTokensOf(c: ContinuityBlock): number {
  const filteredSnapshot = c.activeSnapshot;
  const filteredHandoff = c.sessionHandoff;
  const tokenCount = (s?: string | null): number => (s ? estimateTokens(s) : 0);
  return (
    tokenCount(filteredSnapshot?.task) +
    tokenCount(filteredSnapshot?.summary) +
    tokenCount(filteredSnapshot?.nextStep) +
    tokenCount(filteredHandoff?.summary) +
    tokenCount(filteredHandoff?.nextAction) +
    (filteredHandoff?.artifacts ?? []).reduce((acc, a) => acc + tokenCount(a), 0) +
    (filteredHandoff?.constraints ?? []).reduce((acc, c) => acc + tokenCount(c), 0) +
    tokenCount(
      filteredHandoff?.evidence ? formatHandoffEvidenceLine(filteredHandoff.evidence) : null,
    ) +
    tokenCount(filteredHandoff?.outcome) +
    tokenCount(filteredHandoff?.targetRuntime) +
    tokenCount(filteredHandoff?.cardId) +
    c.recentSessionEvents.reduce((acc, e) => acc + tokenCount(e.content), 0)
  );
}

// A pure read of the caller's recallHistory snapshot against this top-1. HIPPO_ANCHORING=off skips
// even the detect call; CLI paths pass no history (printRecall computes its own hint), so the hint
// stays absent there.
function detectRecallAnchoring(
  { config }: Context,
  opts: RecallOptions,
  topMemoryId: string | null,
): AnchoringOutcome {
  const history = opts.hints?.recallHistory;
  if (!biasHintEnabled(config, 'anchoring') || !history) {
    return { anchoringHint: null, suppressedByInterference: 0 };
  }
  const queryHash = hashQueryText(opts.query);
  const anchoringHint = detectAnchoring(history, queryHash, topMemoryId);
  return {
    anchoringHint,
    suppressedByInterference: anchoringHint?.reason === 'memory_dominance' ? 1 : 0,
  };
}

// Compares the returned top-K's ages with the scope-filtered pool it came from, never `all`, whose
// hidden rows would leak pool shape. A soft warning only; HIPPO_AVAILABILITY=off or a caller
// computing its own hint skips it.
function detectRecallAvailability(
  ctx: Context,
  opts: RecallOptions,
  baseSlice: MemoryEntry[],
  entries: MemoryEntry[],
): AvailabilityHint | null {
  if (!biasHintEnabled(ctx.config, 'availability') || opts.hints?.suppressAvailabilityHint) {
    return null;
  }
  return detectAvailabilityBias({
    topK: baseSlice.map((e) => ({ id: e.id, created: e.created })),
    pool: entries.map((e) => ({ id: e.id, created: e.created })),
  });
}
