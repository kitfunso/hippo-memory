import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/search/types.js';
import { getReranker } from '../../src/rerankers/index.js';
import { clefFlashReranker, clefReranker, createClefReranker, parseClefReply } from '../../src/rerankers/clef.js';
import type { JsonValue } from '../../src/http-util.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const FAKE_TOKEN = 'fake-cloudflare-token-for-tests';
const ENV_KEYS = [
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'HIPPO_CLEF_ENDPOINT',
  'HIPPO_CLEF_ENDPOINT_TOKEN', 'HIPPO_CLEF_TIMEOUT_MS', 'TYPESAFE_API_KEY',
];

function asResult(content: string, score: number): SearchResult {
  return { entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 };
}

function answersFor(nouls: number[]) {
  return Object.fromEntries(nouls.map((v, i) => [`c${i + 1}`, { type: 'noul', noul: v }]));
}

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function workersReply(nouls: number[], model = 'clef-flash'): Response {
  return json({
    result: { model, answers: answersFor(nouls), usage: { input_tokens: 812, output_tokens: 3 } },
    success: true, errors: [], messages: [],
  });
}

const contents = (out: Array<{ entry: { content: string } }>) => out.map((r) => r.entry.content);
const inputs = () => [asResult('alpha', 1.0), asResult('beta', 0.9), asResult('gamma', 0.8)];
const NATIVE = ['alpha', 'beta', 'gamma'];

describe('clef rerankers', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    process.env.CLOUDFLARE_API_TOKEN = FAKE_TOKEN;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('posts the System One body to Workers AI and orders by the enveloped answers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply([0.1, 0.9, 0.5]));
    const out = await createClefReranker('clef-flash')('which one', inputs());

    expect(contents(out)).toEqual(['beta', 'gamma', 'alpha']);
    expect(out.map((r) => r.postRerankRank)).toEqual([1, 2, 3]);
    expect(out[0].preRerankRank).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe('clef-flash');
    expect(body.state).toContain('[2] beta');
    expect(body.questions.c3.type).toBe('noul');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('records the backend, requested and actual model, and usage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply([0.2, 0.4, 0.6], 'clef'));
    const out = await createClefReranker('clef')('q', inputs());
    expect(out[0].rerankProvenance).toEqual({
      backend: 'cloudflare', requestedModel: 'clef', actualModel: 'clef', inputTokens: 812, outputTokens: 3,
    });
  });

  it('makes no network call and keeps the native order when credentials are missing', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.TYPESAFE_API_KEY = 'paid-jev-key-must-not-be-used';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    const out = await createClefReranker('clef-flash')('q', inputs());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(contents(out)).toEqual(NATIVE);
    expect(out.map((r) => r.rerankScore)).toEqual([1.0, 0.9, 0.8]);
    expect(out[0].rerankProvenance).toMatchObject({ backend: 'native', requestedModel: 'clef-flash' });
    expect(String(warnSpy.mock.calls[0][0])).toContain('CLOUDFLARE_API_TOKEN not set');
  });

  it('refuses an account id that is not 32 hex characters without a request', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '../../evil';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    const out = await createClefReranker('clef-flash')('q', inputs());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(contents(out)).toEqual(NATIVE);
  });

  it.each([
    ['a missing answer', { result: { model: 'clef-flash', answers: { c1: { type: 'noul', noul: 0.9 }, c3: { type: 'noul', noul: 0.1 } } } }],
    ['an out-of-range answer', { result: { model: 'clef-flash', answers: answersFor([0.2, 1.5, 0.1]) } }],
    ['a non-numeric answer', { result: { model: 'clef-flash', answers: { ...answersFor([0.2, 0.3]), c3: { type: 'noul', noul: '0.9' } } } }],
    ['a wrong answer type', { result: { model: 'clef-flash', answers: { ...answersFor([0.2, 0.3]), c3: { type: 'score', noul: 0.9 } } } }],
    ['an extra answer', { result: { model: 'clef-flash', answers: answersFor([0.2, 0.3, 0.4, 0.5]) } }],
    ['a different model', { result: { model: 'clef', answers: answersFor([0.2, 0.9, 0.1]) } }],
    ['no model name from Workers AI', { result: { answers: answersFor([0.2, 0.9, 0.1]) } }],
    ['success false', { success: false, errors: [{ message: 'quota' }], result: null }],
  ])('keeps the native order, never a partial reorder, on %s', async (_label, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(body));
    const out = await createClefReranker('clef-flash')('q', inputs());
    expect(contents(out)).toEqual(NATIVE);
    expect(out.every((r) => r.rerankProvenance?.backend === 'native')).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('keeps the native order on a non-2xx status, a non-JSON body and a timeout', async () => {
    const rerank = createClefReranker('clef-flash');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 429));
    expect(contents(await rerank('q', inputs()))).toEqual(NATIVE);
    expect(String(warnSpy.mock.calls[0][0])).toContain('HTTP 429');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(contents(await rerank('q', inputs()))).toEqual(NATIVE);

    process.env.HIPPO_CLEF_TIMEOUT_MS = '5';
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    const out = await rerank('q', inputs());
    expect(contents(out)).toEqual(NATIVE);
    expect(out[0].rerankProvenance?.fallbackReason).toBe('no answer within 5 ms');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('never prints the token in a warning', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await createClefReranker('clef-flash')('q', inputs());
    expect(String(warnSpy.mock.calls[0][0])).not.toContain(FAKE_TOKEN);
  });

  it('sends to HIPPO_CLEF_ENDPOINT, with its own token, and accepts a bare System One reply', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.HIPPO_CLEF_ENDPOINT = 'http://127.0.0.1:8787/ai/run/clef-flash';
    process.env.HIPPO_CLEF_ENDPOINT_TOKEN = 'private-token';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ answers: answersFor([0.3, 0.2, 0.9]) }));
    const out = await createClefReranker('clef-flash')('q', inputs());

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8787/ai/run/clef-flash');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer private-token');
    expect(contents(out)).toEqual(['gamma', 'alpha', 'beta']);
    expect(out[0].rerankProvenance).toMatchObject({ backend: 'private-endpoint', requestedModel: 'clef-flash' });
  });

  it('keeps the native order without a request when HIPPO_CLEF_ENDPOINT is not an http URL', async () => {
    process.env.HIPPO_CLEF_ENDPOINT = 'file:///etc/passwd';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    expect(contents(await createClefReranker('clef')('q', inputs()))).toEqual(NATIVE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the native order without a request above the 64-question cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    const many = Array.from({ length: 70 }, (_, i) => asResult(`cand${i}`, 1 - i / 100));
    const out = await createClefReranker('clef-flash')('q', many, { topK: 65 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toHaveLength(65);
    expect(out.map((r) => r.postRerankRank)).toEqual(Array.from({ length: 65 }, (_, i) => i + 1));
  });

  it('sends the default 40 candidates', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply(Array(40).fill(0.5)));
    const many = Array.from({ length: 45 }, (_, i) => asResult(`cand${i}`, 1 - i / 100));
    const out = await createClefReranker('clef-flash')('q', many);
    expect(Object.keys(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).questions)).toHaveLength(40);
    expect(out).toHaveLength(40);
  });

  it('prefers HIPPO_CLEF_ENDPOINT over Workers AI and never forwards the Cloudflare token to it', async () => {
    process.env.HIPPO_CLEF_ENDPOINT = 'http://localhost:8787/ai/run/clef-flash';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ answers: answersFor([0.3, 0.2, 0.9]) }));
    await createClefReranker('clef-flash')('q', inputs());
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8787/ai/run/clef-flash');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBeNull();
  });

  it.each([
    ['an unparseable URL', 'not a url', 'HIPPO_CLEF_ENDPOINT is not a valid URL'],
    ['embedded credentials', 'https://user:pass@clef.example.com/run', 'must not embed credentials'],
    ['plain http to another host', 'http://10.0.0.5:8787/run', 'must use https unless it is on this machine'],
  ])('refuses %s without a request', async (_label, endpoint, reason) => {
    process.env.HIPPO_CLEF_ENDPOINT = endpoint;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    const out = await createClefReranker('clef-flash')('q', inputs());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(contents(out)).toEqual(NATIVE);
    expect(out[0].rerankProvenance?.fallbackReason).toContain(reason);
    expect(String(warnSpy.mock.calls[0][0])).not.toContain('pass');
  });

  it('keeps only printable ASCII from a hostile cf-ray header, capped at 64 characters', async () => {
    const res = new Response('{}', { status: 500, headers: { 'cf-ray': `abécd${'z'.repeat(100)}` } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const out = await createClefReranker('clef-flash')('q', inputs());
    expect(out[0].rerankProvenance?.fallbackReason).toMatch(/^HTTP 500, ray [\x20-\x7e]{1,64}$/);
  });

  it('keeps the input order on tied scores', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply([0.5, 0.5, 0.5]));
    expect(contents(await createClefReranker('clef-flash')('q', inputs()))).toEqual(NATIVE);
  });

  it('keeps an upstream pre-rerank rank on success and on fallback', async () => {
    const ranked = () => inputs().map((r, i) => ({ ...r, preRerankRank: [7, 3, 5][i] }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(workersReply([0.1, 0.9, 0.5]));
    const ok = await createClefReranker('clef-flash')('q', ranked());
    expect(ok.map((r) => r.preRerankRank)).toEqual([3, 5, 7]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    const fell = await createClefReranker('clef-flash')('q', ranked());
    expect(fell.map((r) => r.preRerankRank)).toEqual([7, 3, 5]);
  });

  it('redacts secrets from the query and the candidates before sending', async () => {
    const secret = `sk-${'a'.repeat(40)}`;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply([0.1, 0.2, 0.3]));
    await createClefReranker('clef-flash')(`q ${secret}`, [asResult(`key ${secret}`, 1), asResult('bravo', 0.9), asResult('charlie', 0.8)]);
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain(secret);
  });

  it('strips Bearer, Basic-auth and JWT shapes from the text it sends', async () => {
    const bearer = `Bearer ${'b'.repeat(24)}`;
    const jwt = `eyJ${'h'.repeat(12)}.eyJ${'p'.repeat(12)}.sig`;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply([0.1, 0.2, 0.3]));
    await createClefReranker('clef-flash')(`q ${bearer}`, [asResult(`tok ${jwt}`, 1), asResult('bravo', 0.9), asResult('charlie', 0.8)]);
    const sent = String(fetchMock.mock.calls[0][1]?.body);
    expect(sent).not.toContain('b'.repeat(24));
    expect(sent).not.toContain(jwt);
  });

  it.each([
    ['HIPPO_CLEF_ENDPOINT_TOKEN', 'https://clef.example.com/run'],
    ['CLOUDFLARE_API_TOKEN', undefined],
  ])('refuses a %s a header cannot carry, without a request or echoing it', async (key, endpoint) => {
    if (endpoint) process.env.HIPPO_CLEF_ENDPOINT = endpoint;
    process.env[key] = 'secret-part-one\nsecret-part-two';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    const out = await createClefReranker('clef-flash')('q', inputs());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(contents(out)).toEqual(NATIVE);
    expect(out[0].rerankProvenance?.fallbackReason).toBe(`${key} has characters a header cannot carry`);
    expect(String(warnSpy.mock.calls[0][0])).not.toContain('secret-part');
  });

  it.each(['15s', '-1', '1.5', '999999999999'])('uses the default timeout for HIPPO_CLEF_TIMEOUT_MS=%s', async (value) => {
    process.env.HIPPO_CLEF_TIMEOUT_MS = value;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply([0.1, 0.2, 0.3]));
    await createClefReranker('clef-flash')('q', inputs());
    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toContain(15_000);
  });

  it('keeps the native order when a reply runs past the byte cap', async () => {
    const huge = new Response(`{"pad":"${'x'.repeat(1024 * 1024 + 10)}"}`, { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(huge);
    const out = await createClefReranker('clef-flash')('q', inputs());
    expect(contents(out)).toEqual(NATIVE);
    expect(out[0].rerankProvenance?.fallbackReason).toBe('reply over 1048576 bytes');
  });

  it('gives every result its own provenance object', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(workersReply([0.1, 0.9, 0.5]));
    const ok = await createClefReranker('clef-flash')('q', inputs());
    expect(ok[0].rerankProvenance).not.toBe(ok[1].rerankProvenance);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const fell = await createClefReranker('clef-flash')('q', inputs());
    expect(fell[0].rerankProvenance).not.toBe(fell[1].rerankProvenance);
  });

  it('returns nothing and makes no request for an empty head', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    const rerank = createClefReranker('clef-flash');
    expect(await rerank('q', [])).toEqual([]);
    expect(await rerank('q', inputs(), { topK: 0 })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a bare reply without a model name only when the model is not required', () => {
    const bare: JsonValue = { answers: answersFor([0.5]) };
    expect(parseClefReply(bare, 1, 'clef-flash', false)).toMatchObject({ scores: [0.5], actualModel: undefined });
    expect(parseClefReply(bare, 1, 'clef-flash', true)).toBe('reply does not name its model');
  });

  it('is registered as clef-flash and clef, with no reranker by default', () => {
    expect(getReranker('clef-flash')).toBe(clefFlashReranker);
    expect(getReranker('clef')).toBe(clefReranker);
    expect(getReranker(undefined)).toBeNull();
  });
});
