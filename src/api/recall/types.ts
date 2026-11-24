import type { ContinuityBlock, LastRecall } from '../../base/ports/store.js';
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
  scorerWindow?: number;
  summarizeOverflow?: boolean;
  freshTailCount?: number;
  freshTailSessionId?: string;
  includeContinuity?: boolean;
}

/** Which rows a recall may return. */
export interface RecallFilterOptions {
  scope?: string;
  project?: CallerProject;
  keepHeldCopies?: boolean;
}

/** The goal-stack boost; the CLI ranking core reads the same part. */
export interface RecallBoostOptions {
  sessionId?: string;
  goalTag?: string;
}

/** Inputs to the bias hints the reply carries. */
export interface RecallHintOptions {
  recallHistory?: RecallHistorySnapshot;
  suppressAvailabilityHint?: boolean;
}

/** What the recall records about itself: the rerank trace, the recall_traces row and the audit
 * rows. */
export interface RecallTraceOptions {
  explain?: boolean;
  suppressRecallTrace?: boolean;
  leadingAudit?: readonly AppendAuditOptions[];
  recordAs?: RecallRecording;
}

/** One recall, its options grouped by the stage that reads them. */
export interface RecallOptions {
  query: string;
  mode?: 'bm25' | 'hybrid' | 'physics';
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
  sources?: GlobalInReach;
  note?: (line: string) => void;
}

/** A recall the caller prints: `show` runs once ranking ends, then `retrieveWithCliCore` records
 * what it returns. */
export interface CliCoreRecall extends CliCoreRanking {
  hostSessionId?: string;
  lastRecall: LastRecall;
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
  leadIn?: string;
  score: number;
  layer: string;
  strength: number;
  isSummary?: boolean;
  substitutedFor?: string[];
  descendantCount?: number;
  isFreshTail?: boolean;
  rerankTrace?: RerankStep[];
  rerankPipeline?: 'cli' | 'api';
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
  continuity?: ContinuityBlock;
  continuityTokens?: number;
  windowSize?: number;
  suppressionSummary?: RecallSuppressionSummary;
  planningFallacyHint?: PlanningFallacyHint;
  planningFallacyWatching?: PlanningFallacyWatching;
  anchoringHint?: AnchoringHint;

  availabilityHint?: AvailabilityHint;
}

/** WYSIATI cutoff transparency: what the pipeline excluded from `results[]`, so the agent does
 * not treat the cutoff as the full picture. Counters are honest per-path reports of the pipeline
 * that produced this RecallResult, not normalized across pipelines. */
export interface RecallSuppressionSummary {
  totalCandidates: number;
  droppedPreRank: number;
  droppedByBudget: number;
  summarySubstitutionsAdded: number;
  freshTailAdded: number;
  suppressedByInterference: number;
}
