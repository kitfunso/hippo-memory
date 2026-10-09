import { envJevModel, envJevTimeoutMs, envTypesafeApiKey } from '../util/env.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
import type { SearchResult } from '../core/search-types.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { createOutageWarning } from './outage-warning.js';
import { rerankerPost } from './remote.js';
import { compareScoresDesc } from '../core/compare.js';
import { errorMessage } from '../util/log.js';

const REQUEST_ID_MAX_CHARS = 64;

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 5_000;
const TRUNCATE_CHARS = 1200;
// Pinned, not `jev-latest`: the eval numbers were measured on this version,
// and the alias moves whenever the vendor ships a release.
const DEFAULT_MODEL = 'jev-1.13.0';
// The pool size the eval numbers were measured at.
export const JEV_DEFAULT_TOP_K = 40;

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

/** The System One `state` and one `noul` question per candidate (`c1`..`cN`). */
export interface RelevanceRequest {
  state: string;
  questions: Record<string, { type: 'noul'; instructions: string }>;
}

/** Redacted query plus numbered, redacted, truncated candidates. Shared with CLEF so both arms see matched input. */
export function buildRelevanceRequest(query: string, head: readonly SearchResult[]): RelevanceRequest {
  // Strict: this text leaves the machine, so Bearer, Basic-auth and JWT shapes go too.
  const lines = head.map((r, i) => `[${i + 1}] ${truncate(redactSecretsStrict(r.entry.content), TRUNCATE_CHARS)}`);
  const state = `Query: ${redactSecretsStrict(query)}\n\nNumbered candidate memories from an AI coding agent's project store:\n\n${lines.join('\n\n')}`;
  const questions: RelevanceRequest['questions'] = {};
  for (let i = 1; i <= head.length; i++) {
    questions[`c${i}`] = {
      type: 'noul',
      instructions: `Probability that candidate ${i} (numbered in the state above) helps answer the query.`,
    };
  }
  return { state, questions };
}

/** One batched request for the whole candidate list. Rejects with the reason when there are no usable scores. */
async function requestScores(query: string, head: SearchResult[]): Promise<number[]> {
  const key = envTypesafeApiKey();
  if (!key) throw new Error('TYPESAFE_API_KEY not set');

  const { state, questions } = buildRelevanceRequest(query, head);

  const resp = await rerankerPost(ENDPOINT, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      state,
      model: envJevModel() ?? DEFAULT_MODEL,
      questions,
    }),
  }, envJevTimeoutMs() ?? DEFAULT_TIMEOUT_MS);
  if (!resp.ok) {
    // A third-party header ends up on stderr, so keep printable ASCII only.
    const requestId = resp.headers.get('x-request-id')?.replace(/[^\x20-\x7e]/g, '').slice(0, REQUEST_ID_MAX_CHARS);
    await resp.body?.cancel();
    throw new Error(`HTTP ${resp.status}${requestId ? `, request ${requestId}` : ''}`);
  }
  const body: { answers?: Record<string, JevAnswer> } = await resp.json();
  const scores = parseScores(body.answers, head.length);
  if (!scores) throw new Error('incomplete or out-of-range answers');
  return scores;
}

/** Builds a Jev reranker around the reranker it degrades to. Exported so a test can pass a stand-in. */
export function createJevReranker(localFallback: RerankerFn): RerankerFn {
  const outage = createOutageWarning('jev', 'falling back to the local cross-encoder');
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const head = results.slice(0, options?.topK ?? JEV_DEFAULT_TOP_K);
    if (head.length === 0) return [];

    let scores: readonly number[];
    try {
      scores = await requestScores(query, head);
      outage.answered();
    } catch (err) {
      // A read path never throws, and never hands back the unranked order
      // without saying so: warn, then use the free local reranker.
      outage.failed(errorMessage(err));
      return localFallback(query, head, options);
    }

    return rankByScores(head, scores);
  };
}

/** Orders `head` by `scores[i]`, keeping any upstream pre-rerank rank. Shared with CLEF. */
export function rankByScores(head: readonly SearchResult[], scores: readonly number[]): RerankResult[] {
  const scored = head.map((r, i) => ({
    ...r,
    rerankScore: scores[i],
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: 0,
  }));
  // Stable sort: ties fall back to the prior relevance order.
  scored.sort((a, b) => compareScoresDesc(a.rerankScore, b.rerankScore));
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return scored;
}
