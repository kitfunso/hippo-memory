import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { extractFacts, type ExtractedFact } from '../src/extract.js';
import { generateDagSummary } from '../src/dag.js';
import { refineSemanticMemory } from '../src/refine-llm.js';

// Real local HTTP server per case; the callers' own `fetcher` option points them at it, so the request bytes are what a real call sends.
type Mode = 'ok' | 'http400' | 'http500' | 'badjson' | 'empty' | 'hang' | 'refused';

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface Wire {
  requests: Recorded[];
  calledUrls: string[];
  fetcher: typeof fetch;
  close: () => Promise<void>;
}

const KEY = 'k-wire-test';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const SKIPPED_HEADERS = new Set(['host', 'connection', 'accept-encoding', 'accept-language', 'sec-fetch-mode', 'user-agent', 'accept']);

function replyFor(mode: Mode, okText: string): { status: number; body: string } | null {
  switch (mode) {
    case 'ok': return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: okText }] }) };
    case 'http400': return { status: 400, body: '{"error":"bad"}' };
    case 'http500': return { status: 500, body: '{"error":"down"}' };
    case 'badjson': return { status: 200, body: 'not json' };
    case 'empty': return { status: 200, body: JSON.stringify({ content: [] }) };
    default: return null;
  }
}

async function startWire(mode: Mode, okText: string): Promise<Wire> {
  const requests: Recorded[] = [];
  const reply = replyFor(mode, okText);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (!SKIPPED_HEADERS.has(k)) headers[k] = String(v);
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers, body: Buffer.concat(chunks).toString('utf8') });
      if (reply === null) return; // 'hang' never answers
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listen() was given a TCP port, so address() is AddressInfo, never a pipe name.
  const port = (server.address() as AddressInfo).port;
  if (mode === 'refused') await new Promise<void>((resolve) => server.close(() => resolve()));
  const calledUrls: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const original = String(input);
    calledUrls.push(original);
    return fetch(`http://127.0.0.1:${port}${new URL(original).pathname}`, init);
  };
  const close = async (): Promise<void> => {
    if (mode === 'refused') return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { requests, calledUrls, fetcher, close };
}

type CallerResult = ExtractedFact[] | string | null;

interface Expected {
  result: CallerResult;
  messages: Array<string | RegExp>;
  requests: number;
}

interface CallerSpec {
  name: string;
  okText: string;
  maxTokens: number;
  bodySha256: string;
  contentLength: string;
  run: (fetcher: typeof fetch, messages: string[]) => Promise<CallerResult>;
  expected: Record<Mode, Expected>;
}

const TIMEOUT_MESSAGE = /aborted due to timeout/;
const NOT_JSON = /Unexpected token/;
const FACT: ExtractedFact = { content: 'Alice likes tea', tags: ['speaker:Alice'], valence: 'positive' };
const DAG_TEXT = 'Alice likes tea and drinks it every morning before work.';
const REFINE_TEXT = 'People prefer tea in the morning.';

// onError callers surface the typed failure through `messages`; refine surfaces it as a warn line on stderr.
const callers: CallerSpec[] = [
  {
    name: 'extractFacts',
    okText: JSON.stringify([FACT]),
    maxTokens: 1200,
    bodySha256: '8a3cca2b99fff9e38016c7e231d5c51515f0a2a1f059ecb4e188e838a3bbfcff',
    contentLength: '806',
    run: (fetcher, messages) => extractFacts('Alice likes tea', { apiKey: KEY, fetcher, onError: (m) => messages.push(m) }),
    expected: {
      ok: { result: [FACT], messages: [], requests: 1 },
      http400: { result: [], messages: ['HTTP 400'], requests: 1 },
      http500: { result: [], messages: ['HTTP 500'], requests: 3 },
      badjson: { result: [], messages: [new RegExp(`^unparseable response: ${NOT_JSON.source}`)], requests: 1 },
      empty: { result: [], messages: [], requests: 1 },
      hang: { result: [], messages: [new RegExp(`^request failed: .*${TIMEOUT_MESSAGE.source}`)], requests: 1 },
      refused: { result: [], messages: ['request failed: fetch failed'], requests: 0 },
    },
  },
  {
    name: 'generateDagSummary',
    okText: DAG_TEXT,
    maxTokens: 400,
    bodySha256: 'b68db51097ea54c1525e168b4b0bbcd6676799af9a254cacda0da32f68b83f28',
    contentLength: '529',
    run: (fetcher, messages) => generateDagSummary('tea', ['Alice likes tea'], { apiKey: KEY, fetcher, onError: (m) => messages.push(m) }),
    expected: {
      ok: { result: DAG_TEXT, messages: [], requests: 1 },
      http400: { result: null, messages: ['HTTP 400'], requests: 1 },
      http500: { result: null, messages: ['HTTP 500'], requests: 3 },
      badjson: { result: null, messages: [new RegExp(`^unparseable response: ${NOT_JSON.source}`)], requests: 1 },
      empty: { result: null, messages: [], requests: 1 },
      hang: { result: null, messages: [new RegExp(`^request failed: .*${TIMEOUT_MESSAGE.source}`)], requests: 1 },
      refused: { result: null, messages: ['request failed: fetch failed'], requests: 0 },
    },
  },
  {
    name: 'refineSemanticMemory',
    okText: REFINE_TEXT,
    maxTokens: 800,
    bodySha256: '7e1b2d5180c0c68708791c2961a1830ba8a6d29fd5b6374d501748b5c5bf9b17',
    contentLength: '809',
    run: (fetcher) => refineSemanticMemory('merged tea notes', [], { apiKey: KEY, fetcher }),
    expected: {
      ok: { result: REFINE_TEXT, messages: [], requests: 1 },
      http400: { result: null, messages: ['[hippo] warn: refine: API answered HTTP 400'], requests: 1 },
      http500: { result: null, messages: ['[hippo] warn: refine: API answered HTTP 500'], requests: 3 },
      badjson: { result: null, messages: [new RegExp(`^\\[hippo\\] warn: refine: unreadable response: ${NOT_JSON.source}`)], requests: 1 },
      empty: { result: null, messages: ['[hippo] warn: refine: response was empty or too short to use'], requests: 1 },
      hang: { result: null, messages: [new RegExp(`^\\[hippo\\] warn: refine: request failed: .*${TIMEOUT_MESSAGE.source}`)], requests: 1 },
      refused: { result: null, messages: ['[hippo] warn: refine: request failed: fetch failed'], requests: 0 },
    },
  },
];

const MODES: Mode[] = ['ok', 'http400', 'http500', 'badjson', 'empty', 'hang', 'refused'];
let stderr: MockInstance<typeof process.stderr.write>;
let savedTimeout: string | undefined;

beforeAll(() => {
  savedTimeout = process.env.HIPPO_LLM_TIMEOUT_MS;
  process.env.HIPPO_LLM_TIMEOUT_MS = '300';
});
afterAll(() => {
  if (savedTimeout === undefined) delete process.env.HIPPO_LLM_TIMEOUT_MS;
  else process.env.HIPPO_LLM_TIMEOUT_MS = savedTimeout;
});
beforeEach(() => { stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterEach(() => { stderr.mockRestore(); });

function warnLines(): string[] {
  return stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('warn: refine')).map((l) => l.replace(/ ts=\S+.*$/s, '').trimEnd());
}

describe.each(callers)('$name over a real local server', (spec) => {
  it.each(MODES)('case %s: request bytes and caller-visible result are unchanged', async (mode) => {
    const wire = await startWire(mode, spec.okText);
    const messages: string[] = [];
    let result: CallerResult;
    try {
      result = await spec.run(wire.fetcher, messages);
    } finally {
      await wire.close();
    }
    const seen = [...messages, ...warnLines()];

    const want = spec.expected[mode];
    expect(result).toEqual(want.result);
    expect(seen).toEqual(want.messages.map((m) => (m instanceof RegExp ? expect.stringMatching(m) : m)));
    expect(wire.requests).toHaveLength(want.requests);
    expect(wire.calledUrls).toHaveLength(Math.max(want.requests, 1));
    for (const url of wire.calledUrls) expect(url).toBe(ANTHROPIC_URL);
    for (const req of wire.requests) {
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/v1/messages');
      expect(req.headers).toEqual({
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-length': spec.contentLength,
      });
      expect(crypto.createHash('sha256').update(req.body).digest('hex')).toBe(spec.bodySha256);
      const parsed: { model: string; max_tokens: number; messages: Array<{ role: string }> } = JSON.parse(req.body);
      expect(Object.keys(parsed)).toEqual(['model', 'max_tokens', 'messages']);
      expect(parsed.model).toBe('claude-sonnet-4-6');
      expect(parsed.max_tokens).toBe(spec.maxTokens);
      expect(parsed.messages.map((m) => m.role)).toEqual(['user']);
    }
  });
});
