import { createRequire } from 'node:module';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

const MODEL_NAME = 'Xenova/ms-marco-MiniLM-L-6-v2';

// Use Function constructor to bypass TypeScript static module resolution
// for optional peer dependencies that may not be installed (mirrors the
// pattern in src/embeddings.ts).
const _dynImport = new Function('s', 'return import(s)') as (
  s: string,
) => Promise<unknown>;
const _require = createRequire(import.meta.url);

const TRANSFORMERS_PACKAGES = ['@huggingface/transformers', '@xenova/transformers'] as const;

function resolveTransformersPackage(): (typeof TRANSFORMERS_PACKAGES)[number] | null {
  for (const name of TRANSFORMERS_PACKAGES) {
    try {
      _require.resolve(name);
      return name;
    } catch {
      // Try the legacy fallback only when the preferred package is not installed.
    }
  }
  return null;
}

async function loadTransformersModule(): Promise<{
  pipeline: (task: string, model: string) => Promise<unknown>;
} | null> {
  // Import one backend only. Loading both native ONNX runtimes in one process
  // can abort during finalization; Hugging Face is the maintained default.
  const name = resolveTransformersPackage();
  if (!name) return null;
  try {
    const mod = (await _dynImport(name)) as {
      pipeline?: (task: string, model: string) => Promise<unknown>;
      default?: {
        pipeline?: (task: string, model: string) => Promise<unknown>;
      };
    };
    const pipeline = mod.pipeline ?? mod.default?.pipeline;
    return typeof pipeline === 'function'
      ? { pipeline }
      : null;
  } catch {
    return null;
  }
}

type CrossEncoderFn = (query: string, candidate: string) => Promise<{ score: number }[]>;
let cachedPipeline: CrossEncoderFn | null = null;
let warnedOnFallback = false;

/**
 * True if a Transformers.js backend is importable. Note: this does NOT confirm
 * that the model is downloadable from Hugging Face CDN — in sandboxed
 * environments the package may import but the model fetch may be blocked.
 * The reranker silently falls back to identity ordering in that case.
 */
export async function isCrossEncoderAvailable(): Promise<boolean> {
  return (await loadTransformersModule()) !== null;
}

async function loadPipeline(): Promise<CrossEncoderFn | null> {
  if (cachedPipeline) return cachedPipeline;
  try {
    const mod = await loadTransformersModule();
    if (!mod) return null;
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
    // Fallback: identity ordering with rerankScore = original score. Warn
    // once per process so a silent identity-fallback doesn't mislead users
    // into thinking the cross-encoder is doing work it isn't.
    if (!warnedOnFallback) {
      warnedOnFallback = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[hippo] cross-encoder reranker unavailable (no Transformers.js backend, or model fetch blocked); falling back to identity ordering. Subsequent calls will not repeat this warning.',
      );
    }
    return head.map((r, i) => ({
      ...r,
      rerankScore: r.score,
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: i + 1,
    }));
  }

  const scored = await Promise.all(
    head.map(async (r, i) => {
      let ceScore: number;
      try {
        const out = await pipe(query, r.entry.content);
        ceScore = Array.isArray(out) && out.length > 0 ? out[0].score : 0;
      } catch {
        // Per-call inference failure (transient tensor error, bad input,
        // etc.): fall back to original score for this candidate so a
        // single bad inference doesn't sink the whole rerank pass.
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

  // T2 note: PLAIN stable score sort on purpose. The input `head` is already
  // deterministically ordered (upstream content tail), so stability inherits
  // that -- and when the cross-encoder produces tied scores (degenerate or
  // no-signal cases), ties MUST fall back to the prior relevance order, not
  // an arbitrary content order (the reranker-cross-encoder micro fixture
  // fails otherwise: an all-tie rerank pass reordered its input).
  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return scored;
};
