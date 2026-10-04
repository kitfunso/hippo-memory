import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/search.js';
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
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const out = await createClefReranker('clef-flash')('q', inputs());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(contents(out)).toEqual(NATIVE);
    expect(out.map((r) => r.rerankScore)).toEqual([1.0, 0.9, 0.8]);
    expect(out[0].rerankProvenance).toMatchObject({ backend: 'native', requestedModel: 'clef-flash' });
    expect(String(warnSpy.mock.calls[0][0])).toContain('CLOUDFLARE_API_TOKEN not set');
  });

  it('refuses an account id that is not 32 hex characters without a request', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '../../evil';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
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
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(contents(await createClefReranker('clef')('q', inputs()))).toEqual(NATIVE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the native order without a request above the 64-question cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
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
