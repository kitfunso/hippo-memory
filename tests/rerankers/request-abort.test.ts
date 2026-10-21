// A client abort ends a reranker's post and is not a reranker outage; a real failure warns with the error's fields.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/base/rank/search-types.js';
import { createClefReranker } from '../../src/domain/rerankers/clef.js';
import { rerankerPost } from '../../src/domain/rerankers/remote.js';
import { createOutageWarning } from '../../src/domain/rerankers/outage-warning.js';
import { processHttp } from '../../src/infra/http.js';
import { log } from '../../src/base/util/log.js';
import { runWithRequestId } from '../../src/base/util/request-scope.js';

const HANDED = {
  cloudflareAccountId: '0123456789abcdef0123456789abcdef',
  cloudflareApiToken: 'handed-down-token',
};
const inputs = (): SearchResult[] =>
  ['alpha', 'beta'].map((c) => ({
    entry: createMemory(c),
    score: 1,
    bm25: 1,
    cosine: 0,
    tokens: 10,
  }));

/** A fetch that never answers and rejects when its signal aborts. */
interface Seen {
  signal?: AbortSignal;
}

function hangingFetch(seen: Seen): typeof fetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      seen.signal = init?.signal ?? undefined;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
}

let warn: MockInstance<typeof log.warn>;
beforeEach(() => {
  warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('rerankerPost and the request signal', () => {
  it('aborts the post when the request aborts, long before the budget', async () => {
    const seen: Seen = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(hangingFetch(seen));
    const request = new AbortController();
    const post = runWithRequestId(
      'req-abort',
      () => rerankerPost(processHttp, 'https://rerank.example.com/run', { body: '{}' }, 60_000),
      undefined,
      request.signal,
    );
    const outcome = expect(post).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    request.abort();
    await outcome;
    expect(seen.signal?.aborted).toBe(true);
  });
});

describe('the outage warning', () => {
  it('records no outage when the request signal aborted', () => {
    const request = new AbortController();
    request.abort();
    const outage = createOutageWarning('clef', 'keeping the native order');
    runWithRequestId('req-abort', () => outage.failed('aborted'), undefined, request.signal);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records the outage when the request is still live', () => {
    createOutageWarning('clef', 'keeping the native order').failed('no answer', { errorClass: 'Error' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toEqual({ errorClass: 'Error' });
  });
});

describe('the CLEF reranker', () => {
  it('keeps the native order and warns with the error fields on a real failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const out = await createClefReranker('clef-flash', processHttp)('q', inputs(), { clef: HANDED });
    expect(out.map((r) => r.entry.content)).toEqual(['alpha', 'beta']);
    const [message, fields] = warn.mock.calls.find(([m]) => String(m).includes('reranker unavailable')) ?? [];
    expect(String(message)).toContain('clef-flash reranker unavailable');
    expect(fields).toEqual(expect.objectContaining({ errorClass: 'TypeError' }));
  });

  it('records no outage when the client aborted the request', async () => {
    const seen: Seen = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(hangingFetch(seen));
    const request = new AbortController();
    const rerank = createClefReranker('clef-flash', processHttp);
    const done = runWithRequestId(
      'req-abort',
      () => rerank('q', inputs(), { clef: HANDED }),
      undefined,
      request.signal,
    );
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    request.abort();
    await done;
    expect(warn.mock.calls.filter(([m]) => String(m).includes('reranker unavailable'))).toEqual([]);
  });
});
