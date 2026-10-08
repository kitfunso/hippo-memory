// Option and result shapes for recall and retrieve.

import type { ContinuityBlock } from '../store/port.js';
import type { MemoryEntry } from '../memory.js';
import type { RerankStep, SearchResult } from '../search/types.js';
import type { PlanningFallacyHint, PlanningFallacyOutput, PlanningFallacyWatching } from '../predictions/planning-fallacy.js';
import type { AnchoringHint, RecallHistorySnapshot } from '../recall-history.js';
import type { AvailabilityHint } from '../availability.js';
import type { AppendAuditOpts } from '../audit.js';
import type { CallerProject } from '../prompt-hook.js';
import type { RankRecallOpts, RankRecallResult } from '../recall-pipeline.js';

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export interface RecallOpts {
  query: string;
  limit?: number;
  /**
   * Scorer-window opt-in. When set, `loadSearchEntries`
   * loads up to `scorerWindow` candidates. When undefined (default),
   * the store-internal 200-row default applies.
   *
   * `scorerWindow` lets callers decouple "how many candidates do I want
   * the scorer to evaluate" from `limit` ("how many do I want returned").
   * Useful when `summarizeOverflow=true` and you want a wider candidate
   * pool to detect more level-2 parent clusters.
   *
   * NOT a hard cap on returned results. Fresh-tail and substituted
   * summaries can extend the result count above `limit`. The CLI's
   * existing slice in `cmdRecall` (cli.ts) is the CLI hard cap; library
   * callers slice themselves if they want one.
   *
   * Validated as a positive finite integer when set. `scorerWindow: 0`
   * or non-finite values throw `RecallContractError` with code
   * `invalid_scorer_window`, because 0 would otherwise fall through to an
   * uncapped fallback.
   *
   * **Input is library-only.** HTTP `/v1/memories`, MCP
   * `hippo_recall`, and `client.ts` thin-client do NOT serialize this
   * INPUT field; remote callers cannot send `scorerWindow` and will see
   * the store default applied. The OUTPUT `RecallResult.windowSize` is
   * always serialized over the wire (HTTP `sendJson` ships the whole
   * RecallResult, so remote callers receive `windowSize: 200` in the
   * response).
   */
  scorerWindow?: number;
  /** Candidate order. `recall` always keeps the BM25 order; `retrieve` honours this. */
  mode?: 'bm25' | 'hybrid' | 'physics';
  /**
   * Restrict results to memories whose `scope` equals this value exactly.
   *
   * When `scope` is undefined or empty, recall applies a DEFAULT-DENY rule:
   * any memory whose scope starts with `'slack:private:'` is filtered out so
   * a frontend caller passing `undefined` cannot accidentally surface
   * private-channel content. Memories with scope=null (the common case for
   * non-Slack content) are still returned.
   */
  scope?: string;
  /**
   * DAG-aware recall. When true (default), entries that overflow the
   * `limit` and share a level-2 parent summary cause that summary to be
   * appended in their place, capped at ceil(limit * 0.3) extra rows. Set to
   * false for a strict limit.
   */
  summarizeOverflow?: boolean;
  /**
   * Fresh tail. When > 0, prepend the last N kind='raw' rows
   * (tenant + scope filtered, dedup against the BM25 hits) so an agent's
   * "what did I just see" recall path always covers the recent window
   * even when the query terms don't match. Capped at 200. Default 0 = off.
   */
  freshTailCount?: number;
  /**
   * Fresh-tail session scope. When set, restricts the fresh-tail
   * window to a specific session. Without it, fresh-tail is tenant-wide,
   * which surfaces newest rows across ALL sessions — useful for "anything
   * new in this tenant", but wrong for "what did I just see in this one
   * conversation". Set to ctx-supplied session id for the correct shape.
   */
  freshTailSessionId?: string;
  /**
   * When true, include a continuity block (active task snapshot, latest matching
   * session handoff, recent session events) on the result. Default false to keep
   * the hot path cheap; agent boot paths should set this to true.
   *
   * All three lookups are tenant-scoped to ctx.tenantId. On a shared store they are
   * the caller's own, keyed by owner and `project`, and empty without a project.
   *
   * Note: when no active snapshot exists, sessionHandoff is null and
   * recentSessionEvents is []. We deliberately do NOT fall back to the latest
   * tenant handoff without a session anchor, to avoid resurrecting stale state
   * after a session ends. The explicit handoff-without-snapshot path remains
   * `hippo session resume`.
   */
  includeContinuity?: boolean;
  project?: CallerProject; // keeps rows to this project and user-global ones, and keys the continuity block
  /**
   * When set AND `(ctx.tenantId, sessionId)` has active goals AND
   * `goalTag` is unset, `api.recall` applies the dlPFC goal-stack boost lifted
   * from CLI cmdRecall. Undefined means no boost.
   *
   * Why on RecallOpts and not Context: Context is shared by remember/recall/
   * assemble/outcome. Goal-stack boost is recall-scoped only.
   */
  sessionId?: string;
  /**
   * Explicit goal-tag override. When set, the goal-stack boost is
   * SUPPRESSED (mirrors the CLI's `goalTag === ''` gate). Use to
   * pin recall ranking against one specific goal/tag without the multi-goal
   * stack interfering.
   */
  goalTag?: string;
  /**
   * Anchoring detector. Caller-supplied snapshot of the per-
   * (tenant, session) recall ring. When present, api.recall computes
   * `RecallResult.anchoringHint` against this snapshot + the just-computed
   * top-1. When undefined (default), no anchoring detection runs on the
   * api.recall surface — but a calling pipeline (CLI cmdRecall, MCP
   * hippo_recall) MAY compute its own hint via the shared
   * `detectAnchoring()` helper against its own ring + top-1.
   *
   * Pure read: api.recall NEVER mutates the snapshot or any caller-side
   * Map. Caller is responsible for appending to its own ring after the
   * recall (passing the resulting hint's memoryId as `anchoredOn` to feed
   * the cooldown logic on the NEXT recall).
   */
  recallHistory?: RecallHistorySnapshot;
  /**
   * When true, api.recall does NOT compute or emit the
   * availabilityHint. Callers that run their OWN per-pipeline availability
   * detection over a different result set (the MCP handler computes it over
   * physics/hybrid results, not api.recall's BM25 band) pass this to avoid a
   * double audit emission and a hint describing a result set the caller never
   * surfaces. Mirrors how anchoring only runs when opts.recallHistory
   * is supplied. HTTP / direct SDK callers leave this unset and receive the hint.
   */
  suppressAvailabilityHint?: boolean;
  /**
   * Recall trace. When true, api.recall captures the lifecycle re-ranking
   * trace (currently the goal-boost step on the primary band) and attaches it
   * to each `RecallResultItem` as `rerankTrace`, plus `rerankPipeline:'api'`.
   * When undefined/false (default), both fields are absent on EVERY band.
   * The api pipeline applies only goal-boost; the richer CLI stages
   * (interference/value/utility/reranker/retrieval-count-downweight) are not traced here.
   */
  explain?: boolean;
  /**
   * When true, api.recall does NOT write a recall_traces row for this call.
   * Mirrors `suppressAvailabilityHint`'s pattern: callers that run their OWN
   * tracing over a DIFFERENT result set must suppress api.recall's copy so
   * the training corpus doesn't get a trace mislabeled as 'api' pipeline
   * when the caller's actual user-visible results came from elsewhere. Under
   * `showRanked` it also drops the 'mcp' trace of the shown list. HTTP /
   * direct SDK callers leave this unset and get the trace.
   */
  suppressRecallTrace?: boolean;
  /** Set only by the MCP recall tool, which ranks with its own scorer and drops copies from its own final list: this call
   *  then keeps a memory that a merged row in the same result holds word for word. Other callers leave it unset. */
  keepHeldCopies?: boolean;
  leadingAudit?: readonly AppendAuditOpts[]; // rows this recall writes first in its one write, so a failed recall writes none; the HTTP route sets it, others leave it unset
  /** MCP recall only: `retrieve` ranks the whole scoped store and strengthens and traces (pipeline 'mcp') just the ids this returns; `results` stays the window band. */
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

/** The CLI ranking core (`rankRecall`) as a ranker of `retrieve`: host admin only, on hippo.db. Of the other RecallOpts it reads `query`, `sessionId` and `goalTag`. */
export type CliCoreRanker = CliCoreRecall | CliCoreInspection;

/** `results`: the rows the caller shows, best first; `audit`: its hint rows, written ahead of the 'recall' row; `tokens`: the text it prints, for the ledger. */
export interface ShownCliCore {
  results: readonly SearchResult[];
  audit: readonly AppendAuditOpts[];
  tokens: number;
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
  /**
   * True when this row is a level-2 topic summary substituted in for
   * overflowed children that didn't fit the limit.
   */
  isSummary?: boolean;
  /**
   * IDs of the overflow leaves this summary covers. Caller can drill
   * into these via `drillDown` to recover the original detail.
   */
  substitutedFor?: string[];
  /** Cached descendant count from schema v25; non-zero for level-2+ rows. */
  descendantCount?: number;
  /**
   * True for rows surfaced via the most-recent-N kind='raw' window, NOT by the
   * BM25 query match. Caller can render them in a separate "recent" band.
   */
  isFreshTail?: boolean;
  /**
   * Ordered lifecycle re-ranking steps that mutated this
   * row's `score` after candidate generation. On the api pipeline this carries
   * the goal-boost step (the only re-ranking api.recall applies). Populated
   * ONLY when `RecallOpts.explain` is set; absent on the default path
   * (additive optional, back-compat per the `windowSize?` precedent;
   * `client.ts` deserializes `as RecallResult` so the field rides through).
   */
  rerankTrace?: RerankStep[];
  /**
   * Names which pipeline produced `rerankTrace`. `'api'` on
   * every band returned by `api.recall` when `explain` is set; the CLI carries
   * its trace on `SearchResult` instead and does not set this. Absent on the
   * default path. Distinguishes the api pipeline (goal-boost only) from the
   * richer CLI pipeline.
   */
  rerankPipeline?: 'cli' | 'api';
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
  continuity?: ContinuityBlock;
  /**
   * Tokens consumed by the continuity block: snapshot (task + summary + next_step)
   * + handoff (summary + nextAction + artifacts + constraints + evidence line)
   * + every event's full content across the last 5 events. Each measured by Math.ceil(len/4), matching
   * the existing `tokens` count and src/search.ts estimateTokens().
   * Undefined when continuity not requested. Callers needing a tighter budget
   * should truncate event.content themselves before display.
   */
  continuityTokens?: number;
  /**
   * Scorer window actually used for this recall. Equals
   * `opts.scorerWindow` when set, otherwise the store-internal default
   * (200) used by `loadSearchEntries(undefined, ...)`. Reported so
   * callers can introspect "did the scorer see enough candidates?"
   * without re-deriving the value.
   *
   * Optional in the type to keep `RecallResult` literal-construction
   * back-compatible with test fakes / mocks that predate the field.
   * Always present on values returned by `api.recall` itself; consumers
   * reading from `api.recall` can treat it as defined.
   */
  windowSize?: number;
  /**
   * WYSIATI cutoff transparency. When present, gives the
   * calling agent a per-pipeline breakdown of what was excluded from
   * `results[]` and why. Always populated by `api.recall`, `cmdRecall`, and
   * the MCP `hippo_recall` handler. Optional in the type for back-compat
   * with test fakes / mocks (same pattern as `windowSize?`).
   *
   * Counters reflect actual filter activity in the pipeline that produced
   * THIS specific RecallResult. api.recall counts its own filter sites;
   * cmdRecall counts its (richer) filter sites; MCP counts the physics/
   * hybrid pipeline's filter sites. Shape is identical across surfaces;
   * numbers are honest per-path reports, NOT normalised cross-pipeline
   * counts.
   */
  suppressionSummary?: RecallSuppressionSummary;
  /**
   * Auto-injected planning-fallacy hint. When the recall
   * query carries a forward-prediction phrase ("will take ~3 days", "ship
   * by Friday", "ETA in 2 weeks") AND the closest matching prediction
   * class has closed historical data, this carries the base-rate stats so
   * the calling agent sees its track record at the moment of forecasting
   * (Lovallo-Kahneman 2003 inside-vs-outside view).
   *
   * Populated by `api.recall` itself via `computePlanningFallacyOutput`.
   * Pipeline-invariant: the value depends only on (queryText, tenantId,
   * predictions table state) — all three are identical regardless of
   * which downstream search pipeline produces the memory list, so MCP
   * and CLI both read this field as the single source of truth (unlike
   * `suppressionSummary` which is per-pipeline).
   *
   * Optional in the type so existing test fakes / mocks of RecallResult
   * remain valid (same pattern as `windowSize?` / `suppressionSummary?`).
   * Disabled by setting `HIPPO_AUTODEBIAS=off`.
   */
  planningFallacyHint?: PlanningFallacyHint;
  /**
   * "Watching" variant emitted when the
   * forward-claim regex matched but no baserate could be produced
   * (either because no prediction class scored ≥ 1 on token overlap,
   * or because ≥2 classes tied at the best score). Mutually exclusive
   * with `planningFallacyHint`: at most one of the two is set per
   * recall. Natural-language queries rarely share non-stopword tokens
   * with class tags, so without it the hint would mostly stay silent. The watching
   * variant gives the agent enough signal to either re-tag the
   * prediction or pass the suggestion through to the user.
   *
   * Pipeline-invariant same as `planningFallacyHint`. Honoured by
   * api.recall, cmdRecall, and MCP handler render paths.
   * Disabled by setting `HIPPO_AUTODEBIAS=off`.
   */
  planningFallacyWatching?: PlanningFallacyWatching;
  /**
   * Recall-recurrence anchoring hint. Populated
   * when api.recall's `opts.recallHistory` snapshot + the just-computed
   * top-1 satisfy the query_repeat or memory_dominance rule.
   *
   * Per-pipeline detection: each pipeline (api.recall, cmdRecall, MCP)
   * computes its OWN hint against its OWN top-1. This field reflects
   * api.recall's compute ONLY. On CLI-routed call paths cmdRecall does
   * NOT thread its ring snapshot through `opts.recallHistory`, so this
   * field is null on CLI-routed calls even when CLI's own hint fires
   * (the user-visible hint there comes from cmdRecall's parallel
   * compute, surfaced via the CLI render path + cmdSuppressionSummary).
   * Non-null on direct SDK / HTTP-routed invocations where the caller
   * threads its own ring snapshot.
   *
   * Disabled by setting `HIPPO_ANCHORING=off`.
   */
  anchoringHint?: AnchoringHint;

  /**
   * Availability/recency-bias hint. Per-pipeline (computed
   * against this pipeline's own returned top-K + the matched candidate pool
   * it was drawn from), soft-warning ONLY: never filters, reorders, or
   * suppresses a result. Fires when the returned slice is recency-dominated
   * while substantially older relevant matches in the same pool were passed
   * over. Disabled by setting `HIPPO_AVAILABILITY=off`.
   */
  availabilityHint?: AvailabilityHint;
}

/**
 * WYSIATI cutoff transparency.
 *
 * Surfaces what the recall pipeline excluded from `results[]` so the calling
 * agent does not treat the cutoff as the full picture (Kahneman's "What You
 * See Is All There Is" failure mode, TFAS ch. 7). Each counter reflects
 * filter activity in the pipeline that produced this RecallResult; counts
 * are honest per-path reports, not normalised cross-pipeline numbers.
 *
 * See `buildSuppressionSummary` for the shared construction helper used by
 * all three pipelines (api.recall, cmdRecall, MCP).
 */
export interface RecallSuppressionSummary {
  /** Total candidates loaded from the store, before any post-load filter or
   *  limit cut. Per-pipeline source:
   *  - api.recall: `all.length` immediately after `loadRecallSearchEntries`
   *  - cmdRecall: candidate count immediately after the initial load
   *  - MCP physics/hybrid: count of entries passed to physicsSearch/hybridSearch
   */
  totalCandidates: number;
  /** Candidates dropped by any non-budget filter site (pre-rank OR post-rank,
   *  but NOT the final budget cut). Field name retains the `preRank` label
   *  for the original framing; semantically: any filter drop that is not the
   *  final limit slice. Per-pipeline source:
   *  - api.recall: `all.length - entries.length` (private-scope JS filter + scope-mismatch defense; pre-rank)
   *  - cmdRecall: SUM of drops from `--as-of`, default-drop of superseded (when `--include-superseded` not set), `--filter-conflicts` (`.filter` drop only), `--outcome` (post-rank), `--layer` (post-rank). `--salience-threshold` HARD drops would also land here; current implementation is soft-rebalance only (logged in `ScoreBreakdown`, not here).
   *  - MCP physics/hybrid: scope-filter drops at the MCP handler before physicsSearch
   */
  droppedPreRank: number;
  /** Candidates loaded but excluded by the final `limit` slice after scoring.
   *  Per-pipeline source:
   *  - api.recall: `entries.length - baseSlice.length`
   *  - cmdRecall: pre-slice candidate count minus final slice count
   *  - MCP physics/hybrid: pre-slice minus post-slice at the physics/hybrid limit
   */
  droppedByBudget: number;
  /** Substituted DAG-L2 summaries added back to mitigate overflow.
   *  Per-pipeline source:
   *  - api.recall: `substituted.length` after the `summarizeOverflow` block
   *  - cmdRecall: 0 (CLI does not run summarizeOverflow)
   *  - MCP physics/hybrid: count of summary rows appended from apiResult.tailOrSummary
   */
  summarySubstitutionsAdded: number;
  /** Fresh-tail `kind='raw'` rows prepended.
   *  Per-pipeline source:
   *  - api.recall: `freshRanked.length` when `freshTailCount > 0`; else 0
   *  - cmdRecall: 0 (CLI does not currently expose fresh-tail)
   *  - MCP physics/hybrid: count of fresh-tail rows appended from apiResult.tailOrSummary
   */
  freshTailAdded: number;
  /** Counter of memories suppressed by detected interference patterns.
   *  Incremented by 1 PER PIPELINE when that
   *  pipeline's own memory_dominance verdict fires (via the
   *  anchoring detector, see `detectAnchoring()` in src/recall-history.ts).
   *  Each pipeline (api.recall, cmdRecall, MCP physics/hybrid) bumps its
   *  OWN suppressionSummary independently because each runs its own
   *  detector against its own top-1 + its own per-(tenant, session) ring
   *  buffer. The number reflects this-pipeline interference only; not a
   *  cross-pipeline aggregate.
   *
   *  No `interference_suppression` table exists; the detector uses
   *  caller-side in-memory rings instead.
   */
  suppressedByInterference: number;
}
