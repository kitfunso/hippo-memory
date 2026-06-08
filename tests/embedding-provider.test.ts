import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveEmbeddingProvider,
  resolveEmbeddingIdentity,
  isEmbeddingConfigured,
} from '../src/embedding-provider.js';
import { saveEmbeddingIndex, embeddingModelRequiresReindex } from '../src/embeddings.js';

function mkRoot(embeddings: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-provider-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ embeddings }), 'utf8');
  return dir;
}

function jsonResponse(data: unknown, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function errorResponse(status: number, body: string): unknown {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

function l2norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

const ENV_KEYS = ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'COHERE_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

describe('EmbeddingProvider', () => {
  beforeEach(() => {
    // Embedding-API hosts are egress-blocked in the build sandbox, so every test
    // here uses a mocked fetch; a real integration test is Workstream C.
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.unstubAllGlobals();
  });

  describe('identity', () => {
    it('local provider id is the bare model (back-compat with stored embedding_model)', () => {
      const root = mkRoot({ provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' });
      expect(resolveEmbeddingIdentity(root)).toBe('Xenova/all-MiniLM-L6-v2');
      expect(resolveEmbeddingProvider(root).kind).toBe('local');
    });

    it('api provider id is `${kind}:${model}`', () => {
      const root = mkRoot({ provider: 'openai', model: 'text-embedding-3-large' });
      expect(resolveEmbeddingIdentity(root)).toBe('openai:text-embedding-3-large');
    });

    it('defaults to the local provider when none is configured', () => {
      const root = mkRoot({ model: 'Xenova/all-MiniLM-L6-v2' });
      expect(resolveEmbeddingProvider(root).kind).toBe('local');
    });

    it('uses the provider flagship model when an api provider is set but no model', () => {
      const root = mkRoot({ provider: 'openai' });
      const p = resolveEmbeddingProvider(root);
      expect(p.model).toBe('text-embedding-3-large');
      expect(p.id).toBe('openai:text-embedding-3-large');
    });
  });

  describe('backwards compatibility (no forced reindex on upgrade)', () => {
    it('an existing MiniLM index is NOT stale for the local provider', () => {
      const root = mkRoot({ provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' });
      // Legacy store: index present, model defaults to MiniLM (the historical default).
      saveEmbeddingIndex(root, { mem_legacy: [0.1, 0.2, 0.3] });
      const identity = resolveEmbeddingIdentity(root);
      expect(embeddingModelRequiresReindex(root, identity)).toBe(false);
    });

    it('switching to an api provider flips the identity and triggers a reindex', () => {
      const root = mkRoot({ provider: 'openai', model: 'text-embedding-3-large' });
      saveEmbeddingIndex(root, { mem_legacy: [0.1, 0.2, 0.3] });
      const identity = resolveEmbeddingIdentity(root);
      expect(embeddingModelRequiresReindex(root, identity)).toBe(true);
    });
  });

  describe('availability + missing key', () => {
    it('resolveEmbeddingProvider never throws for a missing key', () => {
      const root = mkRoot({ provider: 'openai', model: 'text-embedding-3-large' });
      expect(() => resolveEmbeddingProvider(root)).not.toThrow();
      expect(resolveEmbeddingProvider(root).isAvailable()).toBe(false);
    });

    it('embed() throws a clear, key-naming error when the key is missing', async () => {
      const root = mkRoot({ provider: 'openai', model: 'text-embedding-3-large' });
      await expect(resolveEmbeddingProvider(root).embed(['hi'], 'passage')).rejects.toThrow(
        /OPENAI_API_KEY/,
      );
    });

    it('is available once the key is present', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const root = mkRoot({ provider: 'openai', model: 'text-embedding-3-large' });
      expect(resolveEmbeddingProvider(root).isAvailable()).toBe(true);
    });

    it('throws on an unknown provider value (no silent local fallback)', () => {
      const root = mkRoot({ provider: 'opneai', model: 'text-embedding-3-large' });
      expect(() => resolveEmbeddingProvider(root)).toThrow(/Unknown embeddings.provider/);
      expect(isEmbeddingConfigured(root)).toBe(false);
    });

    it('honors embeddings.enabled=false even when the api key is present (no paid calls)', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const root = mkRoot({ provider: 'openai', model: 'text-embedding-3-large', enabled: false });
      expect(resolveEmbeddingProvider(root).isAvailable()).toBe(false);
    });
  });

  describe('request contract + normalization (openai)', () => {
    it('posts to /embeddings with bearer auth and a batched body, and L2-normalizes the result', async () => {
      process.env.OPENAI_API_KEY = 'sk-secret-123';
      const root = mkRoot({ provider: 'openai', model: 'text-embedding-3-large' });
      const fetchMock = vi.fn(async () =>
        jsonResponse({ data: [{ embedding: [3, 0, 4] }, { embedding: [0, 6, 8] }] }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const vecs = await resolveEmbeddingProvider(root).embed(['a', 'b'], 'passage');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
      expect(String(call[0])).toMatch(/\/embeddings$/);
      expect(call[1].headers.authorization).toBe('Bearer sk-secret-123');
      const body = JSON.parse(call[1].body) as { model: string; input: string[] };
      expect(body.model).toBe('text-embedding-3-large');
      expect(body.input).toEqual(['a', 'b']);
      // [3,0,4] -> /5 ; [0,6,8] -> /10
      expect(l2norm(vecs[0])).toBeCloseTo(1, 6);
      expect(l2norm(vecs[1])).toBeCloseTo(1, 6);
      expect(vecs[0][0]).toBeCloseTo(0.6, 6);
    });

    it('chunks requests by batchSize', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const root = mkRoot({ provider: 'openai', model: 'm', batchSize: 1 });
      const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 0] }] }));
      vi.stubGlobal('fetch', fetchMock);

      await resolveEmbeddingProvider(root).embed(['a', 'b', 'c'], 'passage');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('ignores a fractional batchSize and falls back to the default (no chunk explosion)', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const root = mkRoot({ provider: 'openai', model: 'm', batchSize: 0.5 });
      const fetchMock = vi.fn(async () =>
        jsonResponse({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }, { embedding: [1, 0] }] }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await resolveEmbeddingProvider(root).embed(['a', 'b', 'c'], 'passage');
      // 0.5 is rejected -> default batch (64) -> one request for all 3 inputs.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('role -> input_type mapping', () => {
    it('voyage maps query/passage to query/document', async () => {
      process.env.VOYAGE_API_KEY = 'k';
      const root = mkRoot({ provider: 'voyage', model: 'voyage-3' });
      const bodies: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: { body: string }) => {
          bodies.push(JSON.parse(init.body));
          return jsonResponse({ data: [{ embedding: [1] }] });
        }),
      );
      const p = resolveEmbeddingProvider(root);
      await p.embed(['x'], 'query');
      await p.embed(['x'], 'passage');
      expect(bodies[0].input_type).toBe('query');
      expect(bodies[1].input_type).toBe('document');
    });

    it('cohere maps query/passage to search_query/search_document and posts to /embed', async () => {
      process.env.COHERE_API_KEY = 'k';
      const root = mkRoot({ provider: 'cohere', model: 'embed-v4.0' });
      const bodies: Array<Record<string, unknown>> = [];
      const urls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: { body: string }) => {
          urls.push(String(url));
          bodies.push(JSON.parse(init.body));
          return jsonResponse({ embeddings: { float: [[1]] } });
        }),
      );
      const p = resolveEmbeddingProvider(root);
      await p.embed(['x'], 'query');
      await p.embed(['x'], 'passage');
      // Cohere v2 serves embeddings at /v2/embed, not /embeddings.
      expect(urls[0]).toMatch(/\/embed$/);
      expect(bodies[0].input_type).toBe('search_query');
      expect(bodies[1].input_type).toBe('search_document');
    });

    it('openai sends no input_type', async () => {
      process.env.OPENAI_API_KEY = 'k';
      const root = mkRoot({ provider: 'openai', model: 'm' });
      let body: Record<string, unknown> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: { body: string }) => {
          body = JSON.parse(init.body);
          return jsonResponse({ data: [{ embedding: [1] }] });
        }),
      );
      await resolveEmbeddingProvider(root).embed(['x'], 'query');
      expect(body.input_type).toBeUndefined();
    });
  });

  describe('key redaction + hard-failure semantics', () => {
    it('never leaks the key in an error when the API echoes it back', async () => {
      const key = 'sk-supersecret-DEADBEEF';
      process.env.OPENAI_API_KEY = key;
      const root = mkRoot({ provider: 'openai', model: 'm' });
      vi.stubGlobal('fetch', vi.fn(async () => errorResponse(401, `Invalid key ${key} for org`)));

      const err = (await resolveEmbeddingProvider(root)
        .embed(['x'])
        .catch((e) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain(key);
    });

    it('throws on a non-2xx response (so a reindex aborts atomically)', async () => {
      process.env.OPENAI_API_KEY = 'k';
      const root = mkRoot({ provider: 'openai', model: 'm' });
      vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500, 'server error')));
      await expect(resolveEmbeddingProvider(root).embed(['x'])).rejects.toThrow(/500/);
    });

    it('throws when a 200 returns fewer vectors than inputs (contract violation, not silent misses)', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const root = mkRoot({ provider: 'openai', model: 'm' });
      // 200 OK but only one vector for two inputs.
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 0] }] })));
      await expect(resolveEmbeddingProvider(root).embed(['a', 'b'], 'passage')).rejects.toThrow(
        /vectors for/,
      );
    });
  });

  describe('apiBaseUrl validation (https only, localhost exempt)', () => {
    it('rejects a plaintext http base url', () => {
      const root = mkRoot({ provider: 'openai', model: 'm', apiBaseUrl: 'http://evil.example.com/v1' });
      expect(() => resolveEmbeddingProvider(root)).toThrow(/https/i);
    });

    it('accepts an https base url', () => {
      const root = mkRoot({ provider: 'openai', model: 'm', apiBaseUrl: 'https://proxy.example.com/v1' });
      expect(() => resolveEmbeddingProvider(root)).not.toThrow();
    });

    it('allows http for localhost', () => {
      const root = mkRoot({ provider: 'openai', model: 'm', apiBaseUrl: 'http://localhost:1234/v1' });
      expect(() => resolveEmbeddingProvider(root)).not.toThrow();
    });
  });
});
