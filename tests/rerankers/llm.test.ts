import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { boundPort } from '../_helpers/listen.js';
import { createLlmReranker } from '../../src/rerankers/llm.js';
import { getReranker } from '../../src/rerankers/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/core/search-types.js';

// The instance the registry serves, whose outage state lasts the process.
const llmReranker = getReranker('llm')!;

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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '[2, 0, 1]' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'not a permutation' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
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

  it('aborts the fetch and falls back to input ordering on timeout', async () => {
    // Tiny timeout + a fetch that respects AbortSignal proves the
    // AbortController is wired through. Falls back to identity ordering,
    // does NOT throw.
    process.env.HIPPO_LLM_RERANKER_TIMEOUT_MS = '5';
    let abortedFromSignal = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortedFromSignal = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        // never resolves on its own; only the abort can complete it
      });
    });

    const inputs = [asResult('alpha', 1.0), asResult('beta', 0.5)];
    const out = await llmReranker('q', inputs);

    expect(abortedFromSignal).toBe(true);
    expect(out.map((r) => r.entry.content)).toEqual(['alpha', 'beta']);

    delete process.env.HIPPO_LLM_RERANKER_TIMEOUT_MS;
  });

  it('warns once with the status when two calls fail close together, and keeps the input order', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad request', { status: 400 }));
    const rerank = createLlmReranker();
    const inputs = [asResult('alpha', 1.0), asResult('beta', 0.5)];

    const first = await rerank('q', inputs);
    const second = await rerank('q', inputs);

    expect(first.map((r) => r.entry.content)).toEqual(['alpha', 'beta']);
    expect(second.map((r) => r.entry.content)).toEqual(['alpha', 'beta']);
    const warnings = stderr.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('llm reranker unavailable'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('HTTP 400');
  });

  it('names the timeout in its warning', async () => {
    process.env.HIPPO_LLM_RERANKER_TIMEOUT_MS = '5';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await createLlmReranker()('q', [asResult('alpha', 1.0)]);
    delete process.env.HIPPO_LLM_RERANKER_TIMEOUT_MS;
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('no answer within 5 ms');
  });
});

type Answer = 'reset' | 'unavailable' | 'refuse' | 'rank';

describe('llmReranker against a local endpoint', () => {
  let server: http.Server;
  let script: Answer[] = [];
  let hits = 0;

  beforeEach(async () => {
    vi.restoreAllMocks();
    hits = 0;
    server = http.createServer((req, res) => {
      const answer = script[Math.min(hits, script.length - 1)];
      hits++;
      if (answer === 'reset') {
        req.socket.destroy();
        return;
      }
      req.resume();
      if (answer === 'rank') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '[1, 0]' } }] }));
        return;
      }
      res.writeHead(answer === 'unavailable' ? 503 : 400).end();
    });
    server.listen(0, '127.0.0.1');
    process.env.HIPPO_LLM_RERANKER_URL = `http://127.0.0.1:${await boundPort(server)}`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.HIPPO_LLM_RERANKER_URL;
  });

  const inputs = (): SearchResult[] => [asResult('alpha', 1.0), asResult('beta', 0.5)];
  const order = (out: Array<{ entry: { content: string } }>): string[] => out.map((r) => r.entry.content);
  const lines = (stderr: { mock: { calls: unknown[][] } }): string[] => stderr.mock.calls.map((c) => String(c[0]));

  it('reranks when the endpoint drops the first connection and answers the second', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    script = ['reset', 'rank'];
    expect(order(await createLlmReranker()('q', inputs()))).toEqual(['beta', 'alpha']);
    expect(hits).toBe(2);
    expect(lines(stderr)).toEqual([]);
  });

  it('bounds the whole call, retries included, by the configured timeout', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env.HIPPO_LLM_RERANKER_TIMEOUT_MS = '100';
    script = ['unavailable'];
    try {
      expect(order(await createLlmReranker()('q', inputs()))).toEqual(['alpha', 'beta']);
    } finally {
      delete process.env.HIPPO_LLM_RERANKER_TIMEOUT_MS;
    }
    // The first backoff alone outlasts 100 ms, so the second attempt never reaches the endpoint.
    expect(hits).toBe(1);
    expect(lines(stderr).join('')).toContain('no answer within 100 ms');
  });

  it('warns again after five minutes of failure, then says once that the endpoint is back', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Only the clock is faked: the endpoint and the request timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const rerank = createLlmReranker();
    script = ['refuse'];

    await rerank('q', inputs());
    vi.advanceTimersByTime(60_000);
    await rerank('q', inputs());
    vi.advanceTimersByTime(60_000);
    await rerank('q', inputs());
    expect(lines(stderr).filter((line) => line.includes('llm reranker unavailable'))).toHaveLength(1);

    vi.advanceTimersByTime(4 * 60_000);
    await rerank('q', inputs());
    const warnings = lines(stderr).filter((line) => line.includes('llm reranker unavailable'));
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('HTTP 400');
    expect(warnings[1]).toContain('2 more calls failed since the last warning');

    script = ['rank'];
    hits = 0;
    expect(order(await rerank('q', inputs()))).toEqual(['beta', 'alpha']);
    await rerank('q', inputs());
    const recovered = lines(stderr).filter((line) => line.includes('llm reranker is answering again'));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toContain('after 4 failed calls');

    script = ['refuse'];
    hits = 0;
    await rerank('q', inputs());
    // A new outage is reported at once, not held back by the old one's five minutes.
    expect(lines(stderr).filter((line) => line.includes('llm reranker unavailable'))).toHaveLength(3);
  });
});
