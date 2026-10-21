import { createOutageWarning } from './outage-warning.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
import { compareScoresDesc } from '../../base/rank/compare.js';
import type { SearchResult } from '../../base/rank/search-types.js';
import type { CrossEncoderFn, CrossEncoderLoad } from '../../base/ports/cross-encoder.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';

const DEFAULT_CROSS_ENCODER_TOP_K = 50;

/** The head in its input order, scored as it came. */
function identityOrder(head: readonly SearchResult[]): RerankResult[] {
  return head.map((r, i) => ({
    ...r,
    rerankScore: r.score,
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: i + 1,
  }));
}

async function scoreHead(
  pipe: CrossEncoderFn,
  query: string,
  head: readonly SearchResult[],
): Promise<{ readonly results: RerankResult[]; readonly succeeded: number; readonly firstError: Error | null }> {
  let succeeded = 0;
  let firstError: Error | null = null;
  const scored = await Promise.all(
    head.map(async (r, i) => {
      let ceScore: number;
      try {
        ceScore = await pipe(query, r.entry.content);
        succeeded++;
      } catch (err) {
        firstError ??= err instanceof Error ? err : new Error(errorMessage(err));
        // One bad inference must not sink the whole pass; a pass where every call fails is warned about by the outage
        // tracker below.
        log.debug(`cross-encoder inference failed, keeping the base score: ${errorMessage(err)}`, errorFields(err));
        ceScore = r.score;
      }
      return {
        ...r,
        rerankScore: ceScore,
        preRerankRank: r.preRerankRank ?? i + 1,
        postRerankRank: 0,
      };
    }),
  );

  // Plain stable sort on purpose: tied scores MUST fall back to the prior relevance order, never an arbitrary content
  // order.
  scored.sort((a, b) => compareScoresDesc(a.rerankScore, b.rerankScore));
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return { results: scored, succeeded, firstError };
}

/** Track 2 reranker: a cross-encoder from `loadModel`, identity fallback if the model will not load. Each instance owns
 * its outage warning. */
export function createCrossEncoderReranker(loadModel: CrossEncoderLoad): RerankerFn {
  const outage = createOutageWarning('cross-encoder', 'falling back to identity ordering');
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const head = results.slice(0, options?.topK ?? DEFAULT_CROSS_ENCODER_TOP_K);
    let pipe: CrossEncoderFn;
    try {
      pipe = await loadModel();
    } catch (err) {
      // A silent identity fallback otherwise reads as a working reranker.
      outage.failed(errorMessage(err), errorFields(err));
      return identityOrder(head);
    }
    const { results: scored, succeeded, firstError } = await scoreHead(pipe, query, head);
    // A loaded model whose every call throws is as dead as one that never loaded; the first error names why.
    if (head.length > 0 && succeeded === 0) {
      outage.failed(`every inference failed: ${errorMessage(firstError)}`, errorFields(firstError));
    } else {
      outage.answered();
    }
    return scored;
  };
}
