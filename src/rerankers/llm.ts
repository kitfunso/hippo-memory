import { envLlmRerankerKey, envLlmRerankerModel, envLlmRerankerTimeoutMs, envLlmRerankerUrl } from '../util/env.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
import type { SearchResult } from '../core/search-types.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { createOutageWarning } from './outage-warning.js';
import { rerankerPost, RERANKER_MAX_REPLY_BYTES } from './remote.js';
import { readCappedJson } from '../util/capped-json.js';
import { type JsonValue, isJsonObject, isJsonString } from '../util/json.js';
import { errorMessage } from '../util/log.js';

const DEFAULT_LLM_RERANK_TOP_K = 20;

const DEFAULT_TIMEOUT_MS = 30_000;

interface FetchHeaders {
  'content-type': string;
  authorization?: string;
}

/**
 * Track 3 reranker: listwise LLM rerank. Uses a customer-supplied
 * OpenAI-compatible endpoint. Gated on HIPPO_LLM_RERANKER_URL to prevent
 * accidental cost.
 *
 * Skeleton only; full characterisation is deferred.
 *
 * Timeout: defaults to 30s for the whole call, retries included; overridable
 * via HIPPO_LLM_RERANKER_TIMEOUT_MS. On timeout or any failure the reranker
 * falls back to identity ordering; recall must not hang on a wedged endpoint.
 */
export function createLlmReranker(): RerankerFn {
  const outage = createOutageWarning('llm', 'keeping the input order');
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const url = envLlmRerankerUrl();
    if (!url) {
      throw new Error('HIPPO_LLM_RERANKER_URL not set; refusing to run LLM reranker.');
    }
    const head = results.slice(0, options?.topK ?? DEFAULT_LLM_RERANK_TOP_K);

    let permutation: number[] | null = null;
    try {
      permutation = await requestPermutation(url, query, head);
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
async function requestPermutation(url: string, query: string, head: readonly SearchResult[]): Promise<number[]> {
  const key = envLlmRerankerKey();
  const prompt = [
    `Rerank the candidates below by relevance to the query. Output a JSON array of indices (zero-indexed) in best-first order.`,
    `Query: ${redactSecretsStrict(query)}`,
    ...head.map((r, i) => `[${i}] ${redactSecretsStrict(r.entry.content)}`),
    `Output format: [<int>, <int>, ...] with all ${head.length} indices.`,
  ].join('\n');

  const headers: FetchHeaders = {
    'content-type': 'application/json',
  };
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }

  const resp = await rerankerPost(`${url.replace(/\/$/, '')}/chat/completions`, {
    headers: { ...headers },
    body: JSON.stringify({
      model: envLlmRerankerModel() ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  }, envLlmRerankerTimeoutMs() ?? DEFAULT_TIMEOUT_MS);
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`HTTP ${resp.status}`);
  }
  const txt = replyText(await readCappedJson(resp, RERANKER_MAX_REPLY_BYTES));
  const m = txt.match(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/);
  const parsed = m ? m[1].split(',').map((s) => parseInt(s.trim(), 10)) : [];
  const isPermutation =
    parsed.length === head.length &&
    parsed.every((n) => Number.isInteger(n) && n >= 0 && n < head.length) &&
    new Set(parsed).size === head.length;
  if (!isPermutation) throw new Error('reply is not a permutation of the candidates');
  return parsed;
}
