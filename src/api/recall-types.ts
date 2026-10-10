// Option and result shapes for recall and retrieve.

import type { ContinuityBlock } from '../store/port.js';
import type { MemoryEntry } from '../core/memory.js';
import type { RerankStep, SearchResult } from '../core/search-types.js';
import type { PlanningFallacyHint, PlanningFallacyOutput, PlanningFallacyWatching } from '../predictions/planning-fallacy.js';
import type { AnchoringHint, RecallHistorySnapshot } from './recall-history.js';
import type { AvailabilityHint } from './availability.js';
import type { AppendAuditOpts } from '../store/audit.js';
import type { CallerProject } from './prompt-hook.js';
import type { RankRecallOpts, RankRecallResult } from './recall-pipeline.js';
import type { RecallRecording } from './recall-finish.js';

export interface RecallOpts {
  query: string;
  limit?: number;
  /** Candidates the scorer loads (default: the store's 200-row window), decoupled from `limit`; NOT a hard cap, as fresh-tail and summaries can exceed `limit`.
   *  Must be a positive finite integer (else `RecallContractError`, `invalid_scorer_window`). Library-only: HTTP, MCP and `client.ts` do not serialize it. */
  scorerWindow?: number;
  /** Candidate order. `recall` always keeps the BM25 order; `retrieve` honours this. */
  mode?: 'bm25' | 'hybrid' | 'physics';
  /** Exact-match scope filter; when undefined or empty, default-deny drops `slack:private:*` memories so an unscoped caller cannot surface private channels. */
  scope?: string;
  /** DAG-aware recall (default true): entries overflowing `limit` that share a level-2 parent get that summary appended instead, capped at ceil(limit 0.3)
   * extra rows. */
  summarizeOverflow?: boolean;
  /** Fresh tail (default 0 = off, capped at 200): prepend the last N kind='raw' rows (tenant + scope filtered, deduped against BM25 hits) even when the
   * query terms miss. */
  freshTailCount?: number;
  /** Restricts the fresh-tail window to one session; without it the tail is tenant-wide and surfaces newest rows across ALL sessions. */
  freshTailSessionId?: string;
  /** Include a continuity block (active task snapshot, latest matching handoff, recent session events); default false to keep the hot path cheap.
   *  With no active snapshot, sessionHandoff is null and recentSessionEvents is [], so a stale handoff is not resurrected (use `hippo session resume`). */
  includeContinuity?: boolean;
  project?: CallerProject; // keeps rows to this project and user-global ones, and keys the continuity block
  /** With an active goal stack for `(ctx.tenantId, sessionId)` and `goalTag` unset, `api.recall` applies the goal-stack boost; undefined means no boost.
   *  Lives on RecallOpts, not Context, because Context is shared by remember/recall/assemble/outcome and the boost is recall-only. */
  sessionId?: string;
  /** Explicit goal-tag override: when set, the goal-stack boost is SUPPRESSED (mirrors the CLI's `goalTag === ''` gate), pinning ranking to one goal. */
  goalTag?: string;
  /** Caller-supplied snapshot of the per-(tenant, session) recall ring; when present, api.recall computes `anchoringHint` from it, else no anchoring runs here.
   *  Pure read: api.recall never mutates it; the caller appends to its own ring afterwards, passing the hint's memoryId as `anchoredOn` for the cooldown. */
  recallHistory?: RecallHistorySnapshot;
  /** Skip computing and emitting availabilityHint, for callers that run their OWN availability detection over a different result set (e.g. the MCP handler),
   *  to avoid a double audit emission and a hint about a set the caller never surfaces. HTTP and direct SDK callers leave it unset. */
  suppressAvailabilityHint?: boolean;
  /** Capture the lifecycle re-ranking trace (api applies only goal-boost) as `rerankTrace` plus `rerankPipeline:'api'` on each item; both fields are absent
   * when unset. The richer CLI stages are not traced here. */
  explain?: boolean;
  /** Skip the recall_traces row, for callers that trace their OWN different result set, so the training corpus gets no trace mislabeled 'api'.
   *  Under `showRanked` it also drops the 'mcp' trace of the shown list. HTTP and direct SDK callers leave it unset. */
  suppressRecallTrace?: boolean;
  /** Set only by the MCP recall tool, which ranks with its own scorer and drops copies from its own final list: this call
   *  then keeps a memory that a merged row in the same result holds word for word. Other callers leave it unset. */
  keepHeldCopies?: boolean;
  leadingAudit?: readonly AppendAuditOpts[]; // rows this recall writes first in its one write, so a failed recall writes none; `recordAs` fills it
  recordAs?: RecallRecording; // the default ranker then records the recall in full (recall-finish.ts) and fills `recallHistory` and `leadingAudit` itself
  /** MCP recall only: `retrieve` ranks the whole scoped store and strengthens and traces
   * (pipeline 'mcp') just the ids this returns; `results` stays the window band. */
  showRanked?: (ranking: StoreRanking, result: RecallResult) => ShownRanking;
  /** Named ranker: `retrieve` ranks with the CLI ranking core. Unset, it ranks the SQL BM25 band, or the wide hybrid list under `showRanked`. */
  cliCore?: CliCoreRanker;
}

interface CliCoreRanking {
  rank: Omit<RankRecallOpts, 'query' | 'sessionId' | 'goalTag'>;
  /** A second store searched beside `ctx.hippoRoot`. */
  sources?: { globalRoot?: string };
  /** Receives each operator note when ranking reaches it. */
  note?: (line: string) => void;
}

/** A recall the caller prints. `show` runs once ranking ends, unless it halted; `retrieve` then records the list it returns. */
export interface CliCoreRecall extends CliCoreRanking {
  /** The host agent's session: it stamps the token ledger row, and the trace when the recall names no session. */
  hostSessionId?: string;
  show: (ranking: RankRecallResult, planning: PlanningFallacyOutput) => ShownCliCore;
}

/** A read-only look at the ranking (`hippo explain`): no hint is evaluated and nothing is written. */
export interface CliCoreInspection extends CliCoreRanking {
  inspect: (ranking: RankRecallResult) => void;
}

/** The CLI ranking core (`rankRecall`) as a ranker of `retrieve`: host admin only, on
 * hippo.db. Of the other RecallOpts it reads `query`, `sessionId` and `goalTag`. */
export type CliCoreRanker = CliCoreRecall | CliCoreInspection;

/** `results`: the rows the caller shows, best first; `audit`: its hint rows, written
 * ahead of the 'recall' row; `tokens`: the text it prints, for the ledger. */
export interface ShownCliCore {
  results: readonly SearchResult[];
  audit: readonly AppendAuditOpts[];
  tokens: number;
  anchoredOn?: string; // the memory its anchoring hint named; the session ring keeps it for the next recall's cooldown
}

/** `ids`: what the caller showed; `audit`: its own rows, written after the recall's and in the same transaction, so all land or none. */
export interface ShownRanking {
  ids: readonly string[];
  audit: readonly AppendAuditOpts[];
}

/** `ranked`: every scored row, best first, goal boost applied, entries as loaded; `pool`: the store after the scope filter. */
export interface StoreRanking {
  ranked: SearchResult[];
  pool: MemoryEntry[];
  droppedByScope: number;
}

export type { ContinuityBlock } from '../store/port.js';

export interface RecallResultItem {
  id: string;
  content: string;
  score: number;
  layer: string;
  strength: number;
  /** True for a level-2 topic summary substituted in for overflowed children that did not fit the limit. */
  isSummary?: boolean;
  /** IDs of the overflow leaves this summary covers; call `drillDown` on them to recover the detail. */
  substitutedFor?: string[];
  /** Cached descendant count from schema v25; non-zero for level-2+ rows. */
  descendantCount?: number;
  /** True for rows from the most-recent-N kind='raw' window rather than the BM25 match; render them in a separate "recent" band. */
  isFreshTail?: boolean;
  /** Ordered lifecycle re-ranking steps that mutated this row's `score` after candidate generation (on the api pipeline, only goal-boost).
   *  Populated ONLY when `RecallOpts.explain` is set; absent otherwise. */
  rerankTrace?: RerankStep[];
  /** Pipeline that produced `rerankTrace`: 'api' when api.recall set `explain`; the CLI carries its trace on `SearchResult` and leaves this absent. */
  rerankPipeline?: 'cli' | 'api';
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
  continuity?: ContinuityBlock;
  /** Tokens consumed by the continuity block (snapshot, handoff and the last 5 events' full content), each via Math.ceil(len/4) like `tokens`; undefined
   * when not requested. Callers needing a tighter budget should truncate event.content themselves. */
  continuityTokens?: number;
  /** Scorer window used for this recall: `opts.scorerWindow`, else the store default (200). Optional in the type so test fakes built before the field still
   * compile; always present on values returned by `api.recall`. */
  windowSize?: number;
  /** WYSIATI cutoff transparency: what was excluded from `results[]` and why, always populated by `api.recall`, `cmdRecall` and the MCP `hippo_recall` handler.
   *  Counters are per-pipeline reports of that pipeline's own filter sites, not normalised across pipelines. Optional for test fakes. */
  suppressionSummary?: RecallSuppressionSummary;
  /** Planning-fallacy hint: base-rate stats when the query carries a forward-prediction phrase and the closest prediction class has closed data.
   *  Pipeline-invariant (depends only on queryText, tenantId, predictions state), so MCP and CLI read it from here. Disabled by `HIPPO_AUTODEBIAS=off`. */
  planningFallacyHint?: PlanningFallacyHint;
  /** "Watching" variant emitted when the forward-claim regex matched but no baserate could be produced (no class overlap, or a tie at the best score).
   *  Mutually exclusive with `planningFallacyHint`; pipeline-invariant. Disabled by `HIPPO_AUTODEBIAS=off`. */
  planningFallacyWatching?: PlanningFallacyWatching;
  /** Anchoring hint from api.recall's own compute against `opts.recallHistory` (query_repeat or memory_dominance); each pipeline computes its OWN hint.
   *  Null on CLI-routed calls, since cmdRecall does not thread its ring through `opts.recallHistory`. Disabled by `HIPPO_ANCHORING=off`. */
  anchoringHint?: AnchoringHint;

  /** Availability/recency-bias hint: per-pipeline, soft warning only (never filters or reorders); fires when the returned slice is recency-dominated
   *  while older relevant matches in the pool were passed over. Disabled by `HIPPO_AVAILABILITY=off`. */
  availabilityHint?: AvailabilityHint;
}

/** WYSIATI cutoff transparency: what the pipeline excluded from `results[]`, so the agent does not treat the cutoff as the full picture.
 *  Counters are honest per-path reports of the pipeline that produced this RecallResult, not normalised across pipelines. */
export interface RecallSuppressionSummary {
  /** Candidates loaded from the store before any post-load filter or limit cut;
   *  each pipeline counts at its own load (api.recall: after `loadRecallSearchEntries`). */
  totalCandidates: number;
  /** Candidates dropped by any non-budget filter site, pre- or post-rank; the final limit slice is counted in droppedByBudget instead.
   *  Each pipeline counts its own filters (cmdRecall: --as-of, superseded, --filter-conflicts, --outcome, --layer; MCP: scope filter before search). */
  droppedPreRank: number;
  /** Candidates loaded but cut by the final `limit` slice after scoring (api.recall: `entries.length - baseSlice.length`; other pipelines count pre- minus
   * post-slice). */
  droppedByBudget: number;
  /** DAG-L2 summaries substituted back in to mitigate overflow (api.recall: after the `summarizeOverflow` block; cmdRecall: 0; MCP: rows from
   * apiResult.tailOrSummary). */
  summarySubstitutionsAdded: number;
  /** Fresh-tail `kind='raw'` rows prepended (api.recall: `freshRanked.length` when `freshTailCount > 0`; cmdRecall: 0; MCP: rows from
   * apiResult.tailOrSummary). */
  freshTailAdded: number;
  /** Memories suppressed by interference: incremented by 1 PER PIPELINE when its own memory_dominance verdict fires (see `detectAnchoring()` in
   * src/api/recall-history.ts). Each pipeline bumps its OWN summary from its own detector and ring buffer, so this is not a cross-pipeline aggregate. */
  suppressedByInterference: number;
}
