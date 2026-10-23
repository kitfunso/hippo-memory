import {
  envLlmRerankerKey,
  envLlmRerankerModel,
  envLlmRerankerTimeoutMs,
  envLlmRerankerUrl,
} from '../../base/util/env.js';
import type { RerankerFn, RerankResult, RerankerOptions } from '../../base/ports/reranker.js';
import type { Http } from '../../base/ports/http.js';
import type { SearchResult } from '../../base/rank/search-types.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import { createOutageWarning } from '../../domain/rerankers/outage-warning.js';
import { postScoring } from './endpoint.js';
import { readCappedJson } from '../../base/util/capped-json.js';
import { MAX_REPLY_BYTES } from '../../base/util/limits.js';
import { type JsonValue, isJsonObject, isJsonString } from '../../base/util/json.js';
import { errorMessage } from '../../base/util/log.js';
import { parseOutboundUrl } from '../../base/util/net.js';

const DEFAULT_LLM_RERANK_TOP_K = 20;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Track 3 reranker (skeleton): listwise LLM rerank on a customer-supplied OpenAI-compatible endpoint, gated on
 * HIPPO_LLM_RERANKER_URL against accidental cost.
 * Timeout is 30s for the whole call, retries included (HIPPO_LLM_RERANKER_TIMEOUT_MS); any failure falls back to
 * identity ordering, so recall never hangs.
 */
export function createLlmReranker(http: Http): RerankerFn {
  const outage = createOutageWarning('llm', 'keeping the input order');
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const url = envLlmRerankerUrl();
    if (!url) {
      throw new Error('HIPPO_LLM_RERANKER_URL not set; refusing to run LLM reranker.');
    }
    const head = results.slice(0, options?.topK ?? DEFAULT_LLM_RERANK_TOP_K);

    let permutation: number[] | null = null;
    try {
      permutation = await requestPermutation(http, url, query, head);
      outage.answered();
    } catch (err) {
      // A read path never throws, and never hands back the unranked order without saying so.
      outage.failed(errorMessage(err));
    }

    const ordered = permutation ? permutation.map((idx) => head[idx]) : head;
    return ordered.map((r, i) => ({
      ...r,
      rerankScore: ordered.length - i,
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: i + 1,
    }));
  };
}

/** The first choice's message text, or '' when the reply has none. */
function replyText(body: JsonValue): string {
  const choices = isJsonObject(body) ? body.choices : undefined;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const message = isJsonObject(choice) ? choice.message : undefined;
  const content = isJsonObject(message) ? message.content : undefined;
  return isJsonString(content) ? content : '';
}

/** One chat-completions call; rejects with the reason when the reply holds no usable permutation. */
async function requestPermutation(
  http: Http,
  url: string,
  query: string,
  head: readonly SearchResult[],
): Promise<number[]> {
  parseOutboundUrl(url, 'HIPPO_LLM_RERANKER_URL', 'HIPPO_LLM_RERANKER_KEY');
  const key = envLlmRerankerKey();
  const prompt = [
    `Rerank the candidates below by relevance to the query. Output a JSON array of indices (zero-indexed) in ` +
      `best-first order.`,
    `Query: ${redactSecretsStrict(query)}`,
    ...head.map((r, i) => `[${i}] ${redactSecretsStrict(r.entry.content)}`),
    `Output format: [<int>, <int>, ...] with all ${head.length} indices.`,
  ].join('\n');

  const resp = await postScoring(http, {
    url: `${url.replace(/\/$/, '')}/chat/completions`,
    token: key,
    body: {
      model: envLlmRerankerModel() ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    },
    budgetMs: envLlmRerankerTimeoutMs() ?? DEFAULT_TIMEOUT_MS,
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`HTTP ${resp.status}`);
  }
  const txt = replyText(await readCappedJson(resp, MAX_REPLY_BYTES));
  const m = txt.match(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/);
  const parsed = m ? m[1].split(',').map((s) => parseInt(s.trim(), 10)) : [];
  const isPermutation =
    parsed.length === head.length &&
    parsed.every((n) => Number.isInteger(n) && n >= 0 && n < head.length) &&
    new Set(parsed).size === head.length;
  if (!isPermutation) throw new Error('reply is not a permutation of the candidates');
  return parsed;
}
