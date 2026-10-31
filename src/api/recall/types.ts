// Option and result shapes for recall and retrieve.

import type { ContinuityBlock } from '../../base/ports/store.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { RerankStep, SearchResult } from '../../base/rank/search-types.js';
import type {
  PlanningFallacyHint,
  PlanningFallacyOutput,
  PlanningFallacyWatching,
} from '../../base/records/planning-fallacy.js';
import type { RecallRecording, ShownHints } from './finish.js';
import type { AnchoringHint, RecallHistorySnapshot } from './anchoring.js';
import type { AvailabilityHint } from '../availability.js';
import type { CallerProject } from '../prompt-hook.js';
import type { GlobalInReach } from '../types.js';
import type { RankRecallOptions, RankRecallResult } from './pipeline.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';

/** How many rows a recall loads and returns, and the bands it adds beside them. */
export interface RecallWindowOptions {
  limit?: number;
  /** Candidates the scorer loads (default DEFAULT_SEARCH_CANDIDATE_LIMIT), decoupled from `limit`;
   * NOT a hard cap, as fresh-tail and summaries can exceed `limit`. Must be a positive finite
   * integer (else `RecallContractError`, `invalid_scorer_window`). Library-only: HTTP, MCP and
   * `client.ts` do not serialize it. */
  scorerWindow?: number;
  /** DAG-aware recall (default true): entries overflowing `limit` that share a level-2 parent
   * get that summary appended instead, capped at ceil(limit * SUMMARY_SUB_FRACTION) extra rows. */
  summarizeOverflow?: boolean;
  /** Fresh tail (default 0 = off, capped at MAX_FRESH_RAW): prepend the last N kind='raw' rows
   * (tenant + scope filtered, deduped against BM25 hits) even when the query terms miss. */
  freshTailCount?: number;
  /** Restricts the fresh-tail window to one session; without it the tail is tenant-wide and
   * surfaces newest rows across ALL sessions. */
  freshTailSessionId?: string;
  /** Include a continuity block (active task snapshot, latest matching handoff, recent session
   * events); default false to keep the hot path cheap. With no active snapshot, sessionHandoff
   * is null and recentSessionEvents is [], so a stale handoff is not resurrected (use `hippo
   * session resume`). */
  includeContinuity?: boolean;
}

/** Which rows a recall may return. */
export interface RecallFilterOptions {
  /** Exact-match scope filter; when undefined or empty, default-deny drops `slack:private:*`
   * memories so an unscoped caller cannot surface private channels. */
  scope?: string;
  project?: CallerProject; // keeps rows to this project and user-global ones, and keys the continuity block
  /** Set only by the MCP recall tool, which ranks with its own scorer and drops copies from its
   * own final list: this call then keeps a memory that a merged row in the same result holds
   * word for word. Other callers leave it unset. */
  keepHeldCopies?: boolean;
}

/** The goal-stack boost; the CLI ranking core reads the same part. */
export interface RecallBoostOptions {
  /** With an active goal stack for `(ctx.tenantId, sessionId)` and `goalTag` unset, `api.recall`
   * applies the goal-stack boost; undefined means no boost. Lives on RecallOptions, not Context,
   * because Context is shared by remember/recall/assemble/outcome and the boost is recall-only. */
  sessionId?: string;
  /** Explicit goal-tag override: when set, the goal-stack boost is SUPPRESSED (mirrors the CLI's
   * `goalTag === ''` gate), pinning ranking to one goal. */
  goalTag?: string;
}

/** Inputs to the bias hints the reply carries. */
export interface RecallHintOptions {
  /** Caller-supplied snapshot of the per-(tenant, session) recall ring; when present, api.recall
   * computes `anchoringHint` from it, else no anchoring runs here. Pure read: api.recall never
   * mutates it; the caller appends to its own ring afterwards, passing the hint's memoryId as
   * `anchoredOn` for the cooldown. */
  recallHistory?: RecallHistorySnapshot;
  /** Skip computing and emitting availabilityHint, for callers that run their OWN availability
   * detection over a different result set (e.g. the MCP handler), to avoid a double audit
   * emission and a hint about a set the caller never surfaces. HTTP and direct SDK callers leave
   * it unset. */
  suppressAvailabilityHint?: boolean;
}

/** What the recall records about itself: the rerank trace, the recall_traces row and the audit
 * rows. */
export interface RecallTraceOptions {
  /** Capture the lifecycle re-ranking trace (api applies only goal-boost) as `rerankTrace` plus
   * `rerankPipeline:'api'` on each item; both fields are absent when unset. The richer CLI
   * stages are not traced here. */
  explain?: boolean;
  /** Skip the recall_traces row, for callers that trace their OWN different result set, so the training corpus gets no
   *  trace mislabeled 'api'.
   *  Under `retrieveRanking` it also drops the 'mcp' trace of the shown list. HTTP and SDK callers leave it unset. */
  suppressRecallTrace?: boolean;
  // Rows this recall writes first in its one write, so a failed recall writes none; `recordAs`
  // fills it.
  leadingAudit?: readonly AppendAuditOptions[];
  // The ranker then records the recall in full (finish.ts); `retrieve` also fills `recallHistory`
  // and `leadingAudit`.
  recordAs?: RecallRecording;
}

/** One recall, its options grouped by the stage that reads them. */
export interface RecallOptions {
  query: string;
  /** Candidate order. `recall` always keeps the BM25 order; `retrieve` honours this. */
  mode?: 'bm25' | 'hybrid';
  window?: RecallWindowOptions;
  filter?: RecallFilterOptions;
  boost?: RecallBoostOptions;
  hints?: RecallHintOptions;
  trace?: RecallTraceOptions;
}

/** The presenter `retrieveRanking` hands the full BAND_RANKED ranking to; it strengthens and
 * traces (pipeline 'mcp') just the ids returned, and `results` stays the top window of that
 * ranking. */
export type ShowRanking = (ranking: StoreRanking, result: RecallResult) => ShownRanking;

/** The part of RecallOptions the CLI ranking core reads. It has no scope, so
 * `retrieveWithCliCore` needs no scope preflight. */
export type CliCoreQuery = Pick<RecallOptions, 'query' | 'boost'>;

interface CliCoreRanking {
  rank: Omit<RankRecallOptions, 'query' | 'boost'>;
  /** A second store searched beside `ctx.store`: ranking reads it with its own config, and its
   * recall rows go to it. */
  sources?: GlobalInReach;
  /** Receives each operator note when ranking reaches it. */
  note?: (line: string) => void;
}

/** A recall the caller prints: `show` runs once ranking ends, then `retrieveWithCliCore` records
 * what it returns. */
export interface CliCoreRecall extends CliCoreRanking {
  /** The host agent's session: it stamps the token ledger row, and the trace when the recall
   * names no session. */
  hostSessionId?: string;
  show: (
    ranking: RankRecallResult,
    planning: PlanningFallacyOutput,
  ) => ShownCliCore | Promise<ShownCliCore>;
}

/** A read-only look at the ranking (`hippo explain`): no hint is evaluated and nothing is
 * written. */
export interface CliCoreInspection extends CliCoreRanking {
  inspect: (ranking: RankRecallResult) => void;
}

/** The CLI ranking core (`rankRecall`), run by `retrieveWithCliCore`: host admin only, on
 * hippo.db. */
export type CliCoreRanker = CliCoreRecall | CliCoreInspection;

/** `results`: the rows the caller shows, best first; `hints`: the hints over them, whose rows go
 * ahead of the 'recall' row; `tokens`: the text it prints, for the ledger. */
export interface ShownCliCore {
  results: readonly SearchResult[];
  hints: ShownHints;
  tokens: number;
}

/** `ids`: what the caller showed; `hints`: the hints over that list, whose rows go after the
 * recall's in the same transaction, so all land or none. */
export interface ShownRanking {
  ids: readonly string[];
  hints: ShownHints;
  /** Read only under `recordAs`: the shown text's tokens. */
  tokens?: number;
}

/** `ranked`: every scored row, best first, goal boost applied, entries as loaded; `pool`: the
 * store after the scope filter. */
export interface StoreRanking {
  ranked: SearchResult[];
  pool: MemoryEntry[];
  droppedByScope: number;
}

export type { ContinuityBlock } from '../../base/ports/store.js';

export interface RecallResultItem {
  id: string;
  content: string;
  score: number;
  layer: string;
  strength: number;
  /** True for a level-2 topic summary substituted in for overflowed children that did not fit
   * the limit. */
  isSummary?: boolean;
  /** IDs of the overflow leaves this summary covers; call `drillDown` on them to recover the
   * detail. */
  substitutedFor?: string[];
  /** Cached descendant count from schema v25; non-zero for level-2+ rows. */
  descendantCount?: number;
  /** True for rows from the most-recent-N kind='raw' window rather than the BM25 match; render
   * them in a separate "recent" band. */
  isFreshTail?: boolean;
  /** Ordered lifecycle re-ranking steps that mutated this row's `score` after candidate
   * generation (on the api pipeline, only goal-boost). Populated ONLY when
   * `RecallOptions.trace.explain` is set; absent otherwise. */
  rerankTrace?: RerankStep[];
  /** Pipeline that produced `rerankTrace`: 'api' when api.recall set `explain`; the CLI carries
   * its trace on `SearchResult` and leaves this absent. */
  rerankPipeline?: 'cli' | 'api';
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
  continuity?: ContinuityBlock;
  /** Tokens consumed by the continuity block (snapshot, handoff and the last CONTINUITY_EVENT_LIMIT
   *  events' full content), each via Math.ceil(len/4) like `tokens`; undefined when not requested.
   *  Callers needing a tighter budget should truncate event.content themselves. */
  continuityTokens?: number;
  /** Scorer window used for this recall: `opts.scorerWindow`, else DEFAULT_SEARCH_CANDIDATE_LIMIT.
   * Optional in the type so test fakes built before the field still compile; always present on
   * values returned by `api.recall`. */
  windowSize?: number;
  /** WYSIATI cutoff transparency: what was excluded from `results[]` and why, always populated
   * by `api.recall`, `printRecall` and the MCP `hippo_recall` handler. Counters are per-pipeline
   * reports of that pipeline's own filter sites, not normalized across pipelines. Optional for
   * test fakes. */
  suppressionSummary?: RecallSuppressionSummary;
  /** Planning-fallacy hint: base-rate stats when the query carries a forward-prediction phrase
   * and the closest prediction class has closed data. Pipeline-invariant (depends only on
   * queryText, tenantId, predictions state), so MCP and CLI read it from here. Disabled by
   * `HIPPO_AUTODEBIAS=off`. */
  planningFallacyHint?: PlanningFallacyHint;
  /** "Watching" variant emitted when the forward-claim regex matched but no baserate could be produced (no class
   *  overlap, or a tie at the best score).
   *  Mutually exclusive with `planningFallacyHint`; pipeline-invariant. Disabled by `HIPPO_AUTODEBIAS=off`. */
  planningFallacyWatching?: PlanningFallacyWatching;
  /** Anchoring hint from api.recall's own compute against `opts.recallHistory` (query_repeat or
   * memory_dominance); each pipeline computes its OWN hint. Null on CLI-routed calls, since
   * printRecall does not thread its ring through `opts.recallHistory`. Disabled by
   * `HIPPO_ANCHORING=off`. */
  anchoringHint?: AnchoringHint;

  /** Availability/recency-bias hint: per-pipeline, soft warning only (never filters or reorders); fires when the
   *  returned slice is recency-dominated while older relevant matches in the pool were passed over. Disabled by
   *  `HIPPO_AVAILABILITY=off`. */
  availabilityHint?: AvailabilityHint;
}

/** WYSIATI cutoff transparency: what the pipeline excluded from `results[]`, so the agent does
 * not treat the cutoff as the full picture. Counters are honest per-path reports of the pipeline
 * that produced this RecallResult, not normalized across pipelines. */
export interface RecallSuppressionSummary {
  /** Candidates loaded from the store before any post-load filter or limit cut; each pipeline counts at its own load
   *  (api.recall: after `loadRecallSearchEntries`). */
  totalCandidates: number;
  /** Candidates dropped by any non-budget filter site, pre- or post-rank; the final limit slice
   * is counted in droppedByBudget instead. Each pipeline counts its own filters (CLI recall:
   * --as-of, superseded, --filter-conflicts, --outcome, --layer; MCP: scope filter before
   * search). */
  droppedPreRank: number;
  /** Candidates loaded but cut by the final `limit` slice after scoring (api.recall:
   * `entries.length - baseSlice.length`; other pipelines count pre- minus post-slice). */
  droppedByBudget: number;
  /** DAG-L2 summaries substituted back in to mitigate overflow (api.recall: after the
   * `summarizeOverflow` block; printRecall: 0; MCP: rows from apiResult.tailOrSummary). */
  summarySubstitutionsAdded: number;
  /** Fresh-tail `kind='raw'` rows prepended (api.recall: `freshRanked.length` when
   * `freshTailCount > 0`; CLI recall: 0; MCP: rows from apiResult.tailOrSummary). */
  freshTailAdded: number;
  /** Memories suppressed by interference: incremented by 1 PER PIPELINE when its own
   * memory_dominance verdict fires (see `detectAnchoring()` in src/api/recall/anchoring.ts). Each
   * pipeline bumps its OWN summary from its own detector and ring buffer, so this is not a
   * cross-pipeline aggregate. */
  suppressedByInterference: number;
}
