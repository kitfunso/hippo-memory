import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

/**
 * Track 3 reranker: listwise LLM rerank. Uses a customer-supplied
 * OpenAI-compatible endpoint. Gated on HIPPO_LLM_RERANKER_URL to prevent
 * accidental cost.
 *
 * Skeleton only — see docs/plans/2026-05-10-f6-reranker-hardening.md Task 8.
 * Full characterisation deferred to a follow-on plan.
 */
export const llmReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const url = process.env.HIPPO_LLM_RERANKER_URL;
  const key = process.env.HIPPO_LLM_RERANKER_KEY;
  if (!url) {
    throw new Error('HIPPO_LLM_RERANKER_URL not set; refusing to run LLM reranker.');
  }

  const topK = options?.topK ?? 20;
  const head = results.slice(0, topK);

  const prompt = [
    `Rerank the candidates below by relevance to the query. Output a JSON array of indices (zero-indexed) in best-first order.`,
    `Query: ${query}`,
    ...head.map((r, i) => `[${i}] ${r.entry.content}`),
    `Output format: [<int>, <int>, ...] with all ${head.length} indices.`,
  ].join('\n');

  let permutation: number[] | null = null;
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.HIPPO_LLM_RERANKER_MODEL ?? 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });
    if (resp.ok) {
      const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const txt = j.choices?.[0]?.message?.content ?? '';
      const m = txt.match(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/);
      if (m) {
        const parsed = m[1].split(',').map((s) => parseInt(s.trim(), 10));
        if (
          parsed.length === head.length &&
          parsed.every((n) => Number.isInteger(n) && n >= 0 && n < head.length) &&
          new Set(parsed).size === head.length
        ) {
          permutation = parsed;
        }
      }
    }
  } catch {
    // Fall through to identity
  }

  const ordered = permutation
    ? permutation.map((idx) => head[idx])
    : head;

  return ordered.map((r, i) => ({
    ...r,
    rerankScore: ordered.length - i,
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: i + 1,
  }));
};
