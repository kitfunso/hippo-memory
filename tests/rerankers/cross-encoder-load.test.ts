// The cross-encoder's model load is bounded, a failure is fetched again once per backoff window, and the warning carries the real error.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MODEL_LOAD_POLICY } from '../../src/embeddings/transformers.js';
import { createCrossEncoderReranker } from '../../src/rerankers/cross-encoder.js';
import type { RerankerFn } from '../../src/rerankers/types.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/core/search-types.js';

/** A reranker over a stand-in for the optional package, which these tests never install; `fetch` decides how each from_pretrained ends. */
function rerankerFetching(fetch: () => Promise<void>): RerankerFn {
  const pairs = new WeakMap<object, string>();
  const tokenizer = async (_query: string, opts: { text_pair: string }): Promise<{ input_ids: object; attention_mask: object }> => {
    const ids = {};
    pairs.set(ids, opts.text_pair);
    return { input_ids: ids, attention_mask: {} };
  };
  // A higher logit for "beta" puts it first, so identity ordering cannot pass for a loaded model.
  const model = async (inputs: { input_ids: object }): Promise<{ logits: { data: number[] } }> => ({
    logits: { data: [pairs.get(inputs.input_ids) === 'beta' ? 3 : -3] },
  });
  return createCrossEncoderReranker(async () => ({
    name: '@huggingface/transformers',
    mod: {
      AutoTokenizer: { from_pretrained: async () => (await fetch(), tokenizer) },
      AutoModelForSequenceClassification: { from_pretrained: async () => (await fetch(), model) },
    },
  }));
}

const asResult = (content: string, score: number): SearchResult => ({ entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 });
const INPUTS = [asResult('alpha', 1.0), asResult('beta', 0.5)];
const order = (out: readonly SearchResult[]): string[] => out.map((r) => r.entry.content);

let stderr: MockInstance<typeof process.stderr.write>;
const warnings = (): string[] => stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('cross-encoder reranker unavailable'));

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the cross-encoder model load', () => {
  it('gives up on a load that hangs at the timeout and keeps the input order', async () => {
    const rerank = rerankerFetching(() => new Promise(() => {}));

    const out = rerank('q', INPUTS);
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_POLICY.timeoutMs);

    expect(order(await out)).toEqual(['alpha', 'beta']);
    expect(warnings()).toEqual([expect.stringMatching(/did not load within 120 s\).*errorClass=Error/)]);
  });

  it('loads once per backoff window after a failure, not once per recall, and warns with the real error', async () => {
    const fetch = vi.fn(async (): Promise<void> => {
      throw new TypeError('fetch failed: connect ECONNREFUSED');
    });
    const rerank = rerankerFetching(fetch);

    for (let i = 0; i < 3; i++) await rerank('q', INPUTS);
    expect(fetch).toHaveBeenCalledTimes(2); // tokenizer and model, one attempt
    expect(warnings()).toEqual([expect.stringMatching(/\(fetch failed: connect ECONNREFUSED\).*errorClass=TypeError/)]);

    await vi.advanceTimersByTimeAsync(MODEL_LOAD_POLICY.backoffMs);
    await rerank('q', INPUTS);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('scores with the model once a retry after the backoff window loads it', async () => {
    const fetch = vi.fn(async (): Promise<void> => {});
    fetch.mockRejectedValueOnce(new Error('model fetch blocked'));
    const rerank = rerankerFetching(fetch);
    expect(order(await rerank('q', INPUTS))).toEqual(['alpha', 'beta']);

    await vi.advanceTimersByTimeAsync(MODEL_LOAD_POLICY.backoffMs);

    expect(order(await rerank('q', INPUTS))).toEqual(['beta', 'alpha']);
  });
});
