import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemory } from '../../src/memory.js';
import type { SearchResult } from '../../src/search.js';
import { getReranker } from '../../src/rerankers/index.js';
import { createJevReranker, jevReranker } from '../../src/rerankers/jev.js';
import type { RerankerFn } from '../../src/rerankers/types.js';

// The stand-in fallback REVERSES its input, so a fallback is distinguishable
// from both a Jev ordering and an identity ordering.
const reversingFallback: RerankerFn = async (_query, results) =>
  [...results].reverse().map((r, i) => ({
    ...r,
    rerankScore: 1 - i / 10,
    preRerankRank: i + 1,
    postRerankRank: i + 1,
  }));

// warn-once is per reranker, so every test builds its own.
const freshReranker = (): RerankerFn => createJevReranker(reversingFallback);

const FAKE_KEY = 'fake-key-for-tests';

function asResult(content: string, score: number): SearchResult {
  return { entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 };
}

function jevResponse(nouls: Array<number | undefined>, status = 200): Response {
  const answers: Record<string, { type: string; noul?: number }> = {};
  nouls.forEach((v, i) => {
    if (v !== undefined) answers[`c${i + 1}`] = { type: 'noul', noul: v };
  });
  return new Response(JSON.stringify({ answers }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const contents = (out: Array<{ entry: { content: string } }>) => out.map((r) => r.entry.content);

describe('jevReranker', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const inputs = () => [asResult('alpha', 1.0), asResult('beta', 0.9), asResult('gamma', 0.8)];
  const many = (n: number): SearchResult[] =>
    Array.from({ length: n }, (_, i) => asResult(`cand${i}`, 1 - i / 100));

  beforeEach(() => {
    vi.restoreAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.TYPESAFE_API_KEY = FAKE_KEY;
    delete process.env.HIPPO_JEV_TIMEOUT_MS;
    delete process.env.HIPPO_JEV_MODEL;
  });

  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.HIPPO_JEV_TIMEOUT_MS;
    delete process.env.HIPPO_JEV_MODEL;
  });

  it('orders candidates by the returned probabilities, in one batched request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jevResponse([0.1, 0.9, 0.5]));
    const out = await freshReranker()('which one', inputs());

    expect(contents(out)).toEqual(['beta', 'gamma', 'alpha']);
    expect(out.map((r) => r.postRerankRank)).toEqual([1, 2, 3]);
    expect(out[0].preRerankRank).toBe(2);
    expect(out[0].rerankScore).toBe(0.9);

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toContain('Query: which one');
    expect(body.state).toContain('[2] beta');
    expect(Object.keys(body.questions)).toEqual(['c1', 'c2', 'c3']);
    expect(body.questions.c1.type).toBe('noul');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the local reranker, without a request, when the key is unset', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const out = await freshReranker()('q', inputs());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(contents(out)).toEqual(['gamma', 'beta', 'alpha']);
    expect(String(warnSpy.mock.calls[0][0])).toContain('TYPESAFE_API_KEY not set');
  });

  it('falls back on a non-2xx status and names the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse([], 500));
    const out = await freshReranker()('q', inputs());

    expect(contents(out)).toEqual(['gamma', 'beta', 'alpha']);
    expect(String(warnSpy.mock.calls[0][0])).toContain('HTTP 500');
  });

  it('falls back when an answer is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse([0.2, undefined, 0.7]));
    const out = await freshReranker()('q', inputs());
    expect(contents(out)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('falls back when a probability is outside 0 to 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse([0.2, 1.7, 0.7]));
    const out = await freshReranker()('q', inputs());
    expect(contents(out)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('aborts on timeout and falls back instead of hanging or throwing', async () => {
    process.env.HIPPO_JEV_TIMEOUT_MS = '5';
    let aborted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const out = await freshReranker()('q', inputs());

    expect(aborted).toBe(true);
    expect(contents(out)).toEqual(['gamma', 'beta', 'alpha']);
    expect(String(warnSpy.mock.calls[0][0])).toContain('no answer within 5 ms');
  });

  it('warns once per reranker and never prints the key', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const rerank = freshReranker();
    await rerank('q', inputs());
    await rerank('q', inputs());
    await rerank('q', inputs());

    expect(warnSpy).toHaveBeenCalledOnce();
    const text = String(warnSpy.mock.calls[0][0]);
    expect(text).toContain('fetch failed');
    expect(text).not.toContain(FAKE_KEY);
  });

  it('returns an empty list without a request or a warning', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await freshReranker()('q', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is registered under the name jev, wired to the shipped reranker', () => {
    expect(getReranker('jev')).toBe(jevReranker);
  });

  it("sends the default 40 candidates, or the caller's topK", async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jevResponse(Array(40).fill(0.5)))
      .mockResolvedValueOnce(jevResponse(Array(5).fill(0.5)));

    const out = await freshReranker()('q', many(45));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(Object.keys(body.questions)).toHaveLength(40);
    expect(out).toHaveLength(40);

    const out2 = await freshReranker()('q', many(45), { topK: 5 });
    const body2 = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(Object.keys(body2.questions)).toHaveLength(5);
    expect(out2).toHaveLength(5);
  });

  it('hands the fallback the same slice Jev was given', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fallback = vi.fn(reversingFallback);
    await createJevReranker(fallback)('q', many(45));
    expect(fallback.mock.calls[0][1]).toHaveLength(40);
  });

  it('ignores a zero, negative or non-numeric timeout', async () => {
    for (const value of ['0', '-5', 'abc']) {
      process.env.HIPPO_JEV_TIMEOUT_MS = value;
      let signal: AbortSignal | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        signal = init?.signal ?? undefined;
        return jevResponse([0.1, 0.9, 0.5]);
      });
      const out = await freshReranker()('q', inputs());
      expect(contents(out)).toEqual(['beta', 'gamma', 'alpha']);
      expect(signal?.aborted).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it('cuts each candidate to 1200 characters before it leaves the machine', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jevResponse([0.5]));
    await freshReranker()('q', [asResult('x'.repeat(2000), 1.0)]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.state).toContain(`${'x'.repeat(1200)}...`);
    expect(body.state).not.toContain('x'.repeat(1201));
  });

  it('sends HIPPO_JEV_MODEL when it is set', async () => {
    process.env.HIPPO_JEV_MODEL = 'jev-1.13.0';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jevResponse([0.1, 0.9, 0.5]));
    await freshReranker()('q', inputs());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('jev-1.13.0');
  });

  it('names the request id, stripped of control characters', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, headers: { 'x-request-id': 'req-123' } }),
    );
    await freshReranker()('q', inputs());
    const text = String(warnSpy.mock.calls[0][0]);
    expect(text).toContain('request req-123');
    expect(text).toMatch(/^[\x20-\x7e]+$/);
  });

  it('falls back when the body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    const out = await freshReranker()('q', inputs());
    expect(contents(out)).toEqual(['gamma', 'beta', 'alpha']);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
