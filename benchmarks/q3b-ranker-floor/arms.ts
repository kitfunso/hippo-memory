// The three arms: one request shape per ranker of `retrieve()`. Each returns the contents it showed, best first.

import { adminActor, retrieve, type Context } from '../../dist/api.js';
import { engineFlags } from '../../dist/cli/shared.js';
import { loadConfig } from '../../dist/config.js';
import { getReranker } from '../../dist/rerankers/index.js';
import { detectScope } from '../../dist/scope.js';
import type { SearchResult } from '../../dist/search/types.js';
import { getGlobalRoot } from '../../dist/shared.js';
import { getHippoRoot, isInitialized } from '../../dist/store/open.js';
import { resolveTenantId } from '../../dist/tenant.js';
import { STAGE_LABEL, stagesNotRun, type Arm, type EvalQuery } from './queries.ts';

/** Rows every arm shows and records: the HTTP default band, so the three write the same number of rows in a timed call. */
export const SHOWN_ROWS = 10;
// The CLI's default head for a registry reranker.
const RERANKER_TOP_K = 50;

export interface Ranked {
  readonly texts: string[];
  /** Wall time of the `retrieve()` call alone, its recording included. */
  readonly retrieveMs: number;
}

/** Ranks `q` with one arm. Call it inside the query's sandbox and cwd: the store, the global store and the path boost all follow them. */
export async function rankWith(arm: Arm, q: EvalQuery): Promise<Ranked> {
  const missing = stagesNotRun(arm, q.stages);
  if (missing.length > 0) throw new Error(`arm ${arm} cannot run ${missing.map((s) => STAGE_LABEL[s]).join(', ')} for ${q.id}`);
  const ctx: Context = { hippoRoot: getHippoRoot(), tenantId: resolveTenantId({}), actor: adminActor('cli') };
  if (arm === 'A') return cliCore(ctx, q);
  return arm === 'B' ? sqlBm25(ctx, q) : showRanked(ctx, q);
}

/** Arm A: the request `hippo recall` builds, less its rendering. The budget is priced on content tokens, not printed lines. */
async function cliCore(ctx: Context, q: EvalQuery): Promise<Ranked> {
  const config = loadConfig(ctx.hippoRoot);
  const globalRoot = getGlobalRoot();
  const reranker = q.stages.reranker ? getReranker(q.stages.reranker) : null;
  let shown: readonly SearchResult[] = [];
  const [, retrieveMs] = await timed(() => retrieve(ctx, {
    query: q.text,
    sessionId: q.stages.sessionId ?? '',
    goalTag: q.stages.goalTag ?? '',
    cliCore: {
      rank: {
        budget: q.budget,
        cost: (r) => r.tokens,
        limit: SHOWN_ROWS,
        includeSuperseded: q.stages.includeSuperseded === true,
        explicitScope: null,
        activeScope: detectScope(),
        search: { ...engineFlags({}, config), multihop: config.multihop.enabled, explain: false },
        evcAdaptive: q.stages.evcAdaptive === true,
        filterConflicts: q.stages.filterConflicts === true,
        valueAware: q.stages.valueAware === true,
        rerankUtility: q.stages.rerankUtility === true,
        reranker: reranker ? { fn: reranker, topK: RERANKER_TOP_K } : undefined,
        salienceThreshold: q.stages.salienceThreshold,
      },
      // The CLI searches the global store as a second source whenever one exists beside the local store.
      sources: { globalRoot: globalRoot !== ctx.hippoRoot && isInitialized(globalRoot) ? globalRoot : undefined },
      show: (ranking) => {
        shown = ranking.results;
        return { results: ranking.results, audit: [], tokens: ranking.results.reduce((n, r) => n + r.tokens, 0) };
      },
    },
  }));
  return { texts: shown.map((r) => r.entry.content), retrieveMs };
}

/** Arm B: `retrieve` with no mode and no ranker option, as `GET /v1/memories` calls it. */
async function sqlBm25(ctx: Context, q: EvalQuery): Promise<Ranked> {
  const [result, retrieveMs] = await timed(() => retrieve(ctx, { query: q.text, limit: SHOWN_ROWS, ...session(q) }));
  return { texts: result.results.map((r) => r.content), retrieveMs };
}

/** Arm C: the options the MCP recall tool passes, with the ranked list cut to the shown rows in place of its rendering. */
async function showRanked(ctx: Context, q: EvalQuery): Promise<Ranked> {
  const mode = loadConfig(ctx.hippoRoot).physics?.enabled !== false ? 'physics' : 'hybrid';
  let shown: SearchResult[] = [];
  const [, retrieveMs] = await timed(() => retrieve(ctx, {
    query: q.text,
    ...session(q),
    limit: 50,
    mode,
    suppressAvailabilityHint: true,
    keepHeldCopies: true,
    showRanked: ({ ranked }) => {
      shown = ranked.slice(0, SHOWN_ROWS);
      return { ids: shown.map((r) => r.entry.id), audit: [] };
    },
  }));
  return { texts: shown.map((r) => r.entry.content), retrieveMs };
}

async function timed<T>(call: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await call();
  return [value, performance.now() - start];
}

function session(q: EvalQuery): { sessionId?: string } {
  return q.stages.sessionId === undefined ? {} : { sessionId: q.stages.sessionId };
}
