import { crossEncoderReranker } from './cross-encoder.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
import type { SearchResult } from '../search.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 5_000;
const TRUNCATE_CHARS = 1200;

interface JevAnswer {
  noul?: number;
}

let warnedOnFallback = false;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}

// Every failure lands here: a read path degrades to the free local reranker,
// it never throws and never returns the unranked order without saying so.
function fallback(
  reason: string,
  query: string,
  results: SearchResult[],
  options?: RerankerOptions,
): Promise<RerankResult[]> {
  if (!warnedOnFallback) {
    warnedOnFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[hippo] jev reranker unavailable (${reason}); falling back to the local cross-encoder. Subsequent calls will not repeat this warning.`,
    );
  }
  return crossEncoderReranker(query, results, options);
}

function parseScores(answers: Record<string, JevAnswer> | undefined, n: number): number[] | null {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    const v = answers?.[`c${i}`]?.noul;
    if (typeof v !== 'number' || v < 0 || v > 1) return null;
    out.push(v);
  }
  return out;
}

/** Track 4 reranker: hosted TypeSafe Jev, opt-in and paid (TYPESAFE_API_KEY), one batched call per recall.
 *  Any failure warns once and delegates to the local cross-encoder. Scores are not bit-stable run to run.
 *  Cost, env vars, evidence and limits: docs/evals/2026-09-19-jev-reranker.md. */
export const jevReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const topK = options?.topK ?? 40;
  const head = results.slice(0, topK);
  if (head.length === 0) return [];

  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return fallback('TYPESAFE_API_KEY not set', query, results, options);

  const lines = head.map((r, i) => `[${i + 1}] ${truncate(r.entry.content, TRUNCATE_CHARS)}`);
  const state = `Query: ${query}\n\nNumbered candidate memories from an AI coding agent's project store:\n\n${lines.join('\n\n')}`;

  const questions: Record<string, { type: string; instructions: string }> = {};
  for (let i = 1; i <= head.length; i++) {
    questions[`c${i}`] = {
      type: 'noul',
      instructions: `Probability that candidate ${i} (numbered in the state above) helps answer the query.`,
    };
  }

  const timeoutMs =
    Number.parseInt(process.env.HIPPO_JEV_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let scores: number[] | null;
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        state,
        model: process.env.HIPPO_JEV_MODEL ?? 'jev-latest',
        questions,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const requestId = resp.headers.get('x-request-id');
      const reason = `HTTP ${resp.status}${requestId ? `, request ${requestId}` : ''}`;
      return await fallback(reason, query, results, options);
    }
    const body: { answers?: Record<string, JevAnswer> } = await resp.json();
    scores = parseScores(body.answers, head.length);
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `no answer within ${timeoutMs} ms`
        : `request failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    return await fallback(reason, query, results, options);
  } finally {
    clearTimeout(timer);
  }

  // A half-scored list ranks worse than the order it would replace.
  if (!scores) return fallback('incomplete or out-of-range answers', query, results, options);
  const noul: readonly number[] = scores;

  const scored = head.map((r, i) => ({
    ...r,
    rerankScore: noul[i],
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: 0,
  }));

  // Stable sort: ties fall back to the prior relevance order.
  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return scored;
};
