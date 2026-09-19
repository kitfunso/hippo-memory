import { crossEncoderReranker } from './cross-encoder.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
import type { SearchResult } from '../search.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 5_000;
const TRUNCATE_CHARS = 1200;

interface JevAnswer {
  noul?: number;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}

// Number.isFinite rejects a string or null without coercing it, which the
// declared type cannot promise about a third-party payload.
function isProbability(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v) && v >= 0 && v <= 1;
}

// A half-scored list ranks worse than the order it would replace, so one bad
// answer voids the whole response.
function parseScores(answers: Record<string, JevAnswer> | undefined, n: number): number[] | null {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    const v = answers?.[`c${i}`]?.noul;
    if (!isProbability(v)) return null;
    out.push(v);
  }
  return out;
}

/** One batched request for the whole candidate list. Rejects with the reason when there are no usable scores. */
async function requestScores(query: string, head: SearchResult[]): Promise<number[]> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY not set');

  const lines = head.map((r, i) => `[${i + 1}] ${truncate(r.entry.content, TRUNCATE_CHARS)}`);
  const state = `Query: ${query}\n\nNumbered candidate memories from an AI coding agent's project store:\n\n${lines.join('\n\n')}`;
  const questions: Record<string, { type: string; instructions: string }> = {};
  for (let i = 1; i <= head.length; i++) {
    questions[`c${i}`] = {
      type: 'noul',
      instructions: `Probability that candidate ${i} (numbered in the state above) helps answer the query.`,
    };
  }

  const parsed = Number.parseInt(process.env.HIPPO_JEV_TIMEOUT_MS ?? '', 10);
  const timeoutMs = parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      throw new Error(`HTTP ${resp.status}${requestId ? `, request ${requestId}` : ''}`);
    }
    const body: { answers?: Record<string, JevAnswer> } = await resp.json();
    const scores = parseScores(body.answers, head.length);
    if (!scores) throw new Error('incomplete or out-of-range answers');
    return scores;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`no answer within ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Builds a Jev reranker around the reranker it degrades to. Exported so a test can pass a stand-in. */
export function createJevReranker(localFallback: RerankerFn): RerankerFn {
  let warned = false;
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const head = results.slice(0, options?.topK ?? 40);
    if (head.length === 0) return [];

    let scores: readonly number[];
    try {
      scores = await requestScores(query, head);
    } catch (err) {
      // A read path never throws, and never hands back the unranked order
      // without saying so: warn once, then use the free local reranker.
      if (!warned) {
        warned = true;
        const reason = err instanceof Error ? err.message : 'unknown error';
        // eslint-disable-next-line no-console
        console.warn(
          `[hippo] jev reranker unavailable (${reason}); falling back to the local cross-encoder. Subsequent calls will not repeat this warning.`,
        );
      }
      return localFallback(query, results, options);
    }

    const scored = head.map((r, i) => ({
      ...r,
      rerankScore: scores[i],
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: 0,
    }));

    // Stable sort: ties fall back to the prior relevance order.
    scored.sort((a, b) => b.rerankScore - a.rerankScore);
    scored.forEach((r, i) => (r.postRerankRank = i + 1));
    return scored;
  };
}

/** Track 4 reranker: hosted TypeSafe Jev, opt-in and paid (TYPESAFE_API_KEY), one batched call per recall.
 *  Any failure warns once and delegates to the local cross-encoder. Scores are not bit-stable run to run.
 *  Cost, env vars, evidence and limits: docs/evals/2026-09-19-jev-reranker.md. */
export const jevReranker: RerankerFn = createJevReranker(crossEncoderReranker);
