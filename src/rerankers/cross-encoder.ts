import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

const MODEL_NAME = 'Xenova/ms-marco-MiniLM-L-6-v2';

// Use Function constructor to bypass TypeScript static module resolution
// for optional peer dependencies that may not be installed (mirrors the
// pattern in src/embeddings.ts).
const _dynImport = new Function('s', 'return import(s)') as (
  s: string,
) => Promise<unknown>;

type CrossEncoderFn = (query: string, candidate: string) => Promise<{ score: number }[]>;
let cachedPipeline: CrossEncoderFn | null = null;

/**
 * True if @xenova/transformers is importable. Note: this does NOT confirm
 * that the model is downloadable from Hugging Face CDN — in sandboxed
 * environments the package may import but the model fetch may be blocked.
 * The reranker silently falls back to identity ordering in that case.
 */
export async function isCrossEncoderAvailable(): Promise<boolean> {
  try {
    const t = (await _dynImport('@xenova/transformers')) as { pipeline?: unknown };
    return typeof t.pipeline === 'function';
  } catch {
    return false;
  }
}

async function loadPipeline(): Promise<CrossEncoderFn | null> {
  if (cachedPipeline) return cachedPipeline;
  try {
    const mod = (await _dynImport('@xenova/transformers')) as {
      pipeline: (task: string, model: string) => Promise<unknown>;
    };
    const p = (await mod.pipeline('text-classification', MODEL_NAME)) as (
      input: string,
    ) => Promise<unknown>;
    cachedPipeline = async (query: string, candidate: string) => {
      const out = (await p(`${query} [SEP] ${candidate}`)) as
        | { score: number }[]
        | { score: number };
      return Array.isArray(out) ? out : [out];
    };
    return cachedPipeline;
  } catch {
    return null;
  }
}

/**
 * Track 2 reranker: MS-MARCO MiniLM cross-encoder.
 * Loads model on first call, then sub-100ms per query for top-K=50 candidates
 * on a typical developer laptop CPU. Falls back to identity ordering if the
 * model fails to load (no transformers, no network for first download, etc.).
 *
 * See docs/plans/2026-05-10-f6-reranker-hardening.md Task 6.
 */
export const crossEncoderReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const topK = options?.topK ?? 50;
  const head = results.slice(0, topK);

  const pipe = await loadPipeline();
  if (!pipe) {
    // Fallback: identity ordering with rerankScore = original score
    return head.map((r, i) => ({
      ...r,
      rerankScore: r.score,
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: i + 1,
    }));
  }

  const scored = await Promise.all(
    head.map(async (r, i) => {
      const out = await pipe(query, r.entry.content);
      const ceScore = Array.isArray(out) && out.length > 0 ? out[0].score : 0;
      return {
        ...r,
        rerankScore: ceScore,
        preRerankRank: r.preRerankRank ?? i + 1,
        postRerankRank: 0,
      };
    }),
  );

  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return scored;
};
