import { describe, it, expect, vi, beforeEach } from 'vitest';
import { llmReranker } from '../../src/rerankers/llm.js';
import { createMemory } from '../../src/memory.js';
import type { SearchResult } from '../../src/search.js';

function asResult(content: string, score: number): SearchResult {
  return { entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 };
}

describe('llmReranker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.HIPPO_LLM_RERANKER_URL = 'http://mock';
    process.env.HIPPO_LLM_RERANKER_KEY = 'mock';
  });

  it('parses model output as a permutation and reorders accordingly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[2, 0, 1]' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as never,
    );

    const inputs = [
      asResult('alpha content', 1.0),
      asResult('beta content', 0.9),
      asResult('gamma content', 0.8),
    ];
    const out = await llmReranker('test query', inputs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(out[0].entry.content).toBe('gamma content');
    expect(out[1].entry.content).toBe('alpha content');
    expect(out[2].entry.content).toBe('beta content');
  });

  it('falls back to input ordering when the model returns malformed output', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'not a permutation' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as never,
    );
    const inputs = [asResult('alpha', 1.0), asResult('beta', 0.5)];
    const out = await llmReranker('q', inputs);
    expect(out.map((r) => r.entry.content)).toEqual(['alpha', 'beta']);
  });

  it('refuses to run when HIPPO_LLM_RERANKER_URL is unset', async () => {
    delete process.env.HIPPO_LLM_RERANKER_URL;
    delete process.env.HIPPO_LLM_RERANKER_KEY;
    await expect(llmReranker('q', [asResult('xyz', 1.0)])).rejects.toThrow(/HIPPO_LLM_RERANKER_URL/);
  });
});
