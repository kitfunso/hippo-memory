// What the `hippo recall` verb reads beside its ranking core: the stores it searches, the resume packet and the JSON rows.

import { confidenceFacets, Layer } from '../core/memory.js';
import { isGlobalStoreRoot } from '../core/project-identity.js';
import type { ResultCost, SearchResult } from '../core/search-types.js';
import { getReranker } from '../rerankers/index.js';
import { isClefModel } from '../rerankers/clef.js';
import { JEV_DEFAULT_TOP_K } from '../rerankers/jev.js';
import type { RerankerFn } from '../rerankers/types.js';
import { explainMatch } from '../search/explain.js';
import { fitBudget } from '../search/finalize.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { detectScope } from '../sharing/scope.js';
import { loadLatestHandoff } from '../store/handoffs.js';
import { loadIndex } from '../store/index-and-stats.js';
import { isInitialized } from '../store/open.js';
import type { ContinuityBlock } from '../store/port.js';
import { passesScopeFilterForRecall } from '../core/recall-scope.js';
import { listSessionEvents, loadActiveTaskSnapshot } from '../store/sessions.js';
import type { Context } from './types.js';

export { DEFAULT_MAX_NEIGHBORS, MAX_HOPS } from '../graph/recall.js';

/** The global store beside this one, whether this one is it, and the scope that boosts rows. */
export interface CliRecallSetting {
  readonly globalRoot: string;
  readonly primaryIsGlobal: boolean;
  readonly activeScope: string | null;
}

/** The active scope merges `--scope` with the detected one, which only boosts. */
export function cliRecallSetting(ctx: Context, explicitScope: string | null): CliRecallSetting {
  return { globalRoot: getGlobalRoot(), primaryIsGlobal: isGlobalStoreRoot(ctx.hippoRoot), activeScope: explicitScope || detectScope() };
}

export interface CliRecallOrigin {
  readonly globalOn: boolean;
  /** True when a ranked row came from the global store: this store is it, or the global store is on and this one lacks the id. */
  readonly isGlobal: (id: string) => boolean;
}

export function cliRecallOrigin(ctx: Context, setting: CliRecallSetting): CliRecallOrigin {
  const localIndex = loadIndex(ctx.hippoRoot);
  const globalOn = isInitialized(setting.globalRoot);
  return { globalOn, isGlobal: (id) => setting.primaryIsGlobal || (globalOn && !localIndex.entries[id]) };
}

/** The active snapshot, its session's latest handoff and last five events, each kept only when its scope passes. */
export function loadCliRecallContinuity(ctx: Context, setting: CliRecallSetting, wanted: boolean): ContinuityBlock {
  if (!wanted || setting.primaryIsGlobal) return { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] };
  const { hippoRoot, tenantId } = ctx;
  const rawSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);
  const sessionId = rawSnapshot?.session_id ?? undefined;
  const rawHandoff = sessionId ? loadLatestHandoff(hippoRoot, tenantId, sessionId) : null;
  const rawEvents = sessionId ? listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, limit: 5 }) : [];
  // The same shared scope rule as api.recall; the active scope merges --scope and detectScope().
  const effectiveScope = setting.activeScope || undefined;
  const passes = (r: { scope?: string | null }): boolean => passesScopeFilterForRecall(r.scope ?? null, effectiveScope);
  return {
    activeSnapshot: rawSnapshot && passes(rawSnapshot) ? rawSnapshot : null,
    sessionHandoff: rawHandoff && passes(rawHandoff) ? rawHandoff : null,
    recentSessionEvents: rawEvents.filter(passes),
  };
}

export interface CliRecallRerankerPick {
  readonly fn: RerankerFn;
  readonly defaultTopK: number;
}

/** The reranker a `--reranker` name picks and the top-k it takes by default; an unknown name throws, a blank one picks none. */
export function cliRecallReranker(name: string): CliRecallRerankerPick | null {
  const fn = getReranker(name);
  if (!fn) return null;
  return { fn, defaultTopK: name === 'jev' || isClefModel(name) ? JEV_DEFAULT_TOP_K : 50 };
}

/** The ranked rows a print budget holds, best first; the first `floor` stay whatever they cost. */
export function fitRecallRows(ranked: SearchResult[], budget: number, floor: number, cost: ResultCost): SearchResult[] {
  return fitBudget(ranked, budget, floor, cost);
}

/** One result row; the optional keys are set in the order the JSON prints them. */
export interface RecallJsonRow {
  id: string;
  score: number;
  strength: SearchResult['entry']['strength'];
  tokens: number;
  tags: SearchResult['entry']['tags'];
  content: string;
  layer: SearchResult['entry']['layer'];
  trace_outcome?: SearchResult['entry']['trace_outcome'];
  superseded?: boolean;
  superseded_by?: SearchResult['entry']['superseded_by'];
  graphVia?: SearchResult['graphVia'];
  confidence?: ReturnType<typeof confidenceFacets>['tier'];
  aged_out?: ReturnType<typeof confidenceFacets>['agedOut'];
  source?: 'global' | 'local';
  reason?: ReturnType<typeof explainMatch>['reason'];
  bm25?: SearchResult['bm25'];
  cosine?: SearchResult['cosine'];
  envelope?: ReturnType<typeof explainMatch>['envelope'];
  rerankTrace?: SearchResult['rerankTrace'];
}

export function recallJsonRow(r: SearchResult, query: string, showWhy: boolean, isGlobal: boolean): RecallJsonRow {
  const base: RecallJsonRow = {
    id: r.entry.id,
    score: r.score,
    strength: r.entry.strength,
    tokens: r.tokens,
    tags: r.entry.tags,
    content: r.entry.content,
    layer: r.entry.layer,
  };
  if (r.entry.layer === Layer.Trace) {
    base.trace_outcome = r.entry.trace_outcome;
  }
  if (r.entry.superseded_by) {
    base.superseded = true;
    base.superseded_by = r.entry.superseded_by;
  }
  if (r.graphVia) {
    base.graphVia = r.graphVia;
  }
  if (showWhy) {
    const explanation = explainMatch(query, r);
    const facets = confidenceFacets(r.entry);
    base.confidence = facets.tier;
    base.aged_out = facets.agedOut;
    base.source = isGlobal ? 'global' : 'local';
    base.reason = explanation.reason;
    base.bm25 = r.bm25;
    base.cosine = r.cosine;
    if (explanation.envelope) {
      base.envelope = explanation.envelope;
    }
    // The ordered lifecycle re-ranking steps, so a caller can see why a row moved.
    if (r.rerankTrace && r.rerankTrace.length > 0) {
      base.rerankTrace = r.rerankTrace;
    }
  }
  return base;
}
