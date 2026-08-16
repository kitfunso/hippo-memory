import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

function writeConfig(hippoRoot: string, model: string): void {
  fs.writeFileSync(
    path.join(hippoRoot, 'config.json'),
    JSON.stringify({ embeddings: { model } }, null, 2),
    'utf8',
  );
}

/**
 * Point config.embeddings at a real API-shaped provider (Voyage) instead of
 * the local transformers.js path: `@huggingface/transformers` is an optional
 * peer dependency that is NOT installed in this repo's devDependencies, so
 * LocalEmbeddingProvider.isAvailable() is always false here. The API
 * provider's isAvailable() only checks for an env var key, so pairing it
 * with a real local HTTP stub (below) exercises hippo's genuine
 * ApiEmbeddingProvider wiring end to end, with zero module mocking.
 */
function writeVoyageConfig(hippoRoot: string, model: string, apiBaseUrl: string): void {
  fs.writeFileSync(
    path.join(hippoRoot, 'config.json'),
    JSON.stringify({ embeddings: { provider: 'voyage', model, apiBaseUrl } }, null, 2),
    'utf8',
  );
}

type EmbedRequestBody = { model: string; input: string[]; input_type?: string };

function parseEmbedRequestBody(raw: string): EmbedRequestBody {
  // SAFETY: this body is captured from the repo's own ApiEmbeddingProvider
  // (src/embedding-provider.ts API_SHAPES.voyage.buildBody), which always
  // POSTs exactly `{ model, input, input_type? }`.
  return JSON.parse(raw) as EmbedRequestBody;
}

function serverPort(server: Server): number {
  const address = server.address();
  // SAFETY: this server always listens on a numeric TCP port via
  // `listen(0, host)`, so `.address()` returns an AddressInfo, never the
  // string form node:net uses only for Unix domain sockets.
  return (address as AddressInfo).port;
}

/**
 * A minimal stand-in for the Voyage embeddings endpoint. Records every
 * request body it receives so tests can assert on what hippo actually sent
 * over the wire, instead of intercepting a hippo module.
 */
async function startEmbeddingStub(vector: number[]): Promise<{
  url: string;
  requests: EmbedRequestBody[];
  close: () => Promise<void>;
}> {
  const requests: EmbedRequestBody[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = parseEmbedRequestBody(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: vector })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${serverPort(server)}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('embedding model configuration', () => {
  let tmpDir: string;
  let prevVoyageKey: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-model-'));
    prevVoyageKey = process.env.VOYAGE_API_KEY;
    // Dummy value: the local stub server never validates it. Real presence
    // check only (ApiEmbeddingProvider.isAvailable()), same as production.
    process.env.VOYAGE_API_KEY = 'test-voyage-key';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevVoyageKey === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prevVoyageKey;
  });

  it('resolves the configured embedding model when no explicit override is provided', async () => {
    writeConfig(tmpDir, 'custom/model');

    const { resolveEmbeddingModel } = await import('../src/embeddings.js');

    expect(resolveEmbeddingModel(tmpDir)).toBe('custom/model');
  });

  it('hybridSearch embeds the query via the provider built from the configured model', async () => {
    const stub = await startEmbeddingStub([1, 0, 0]);
    try {
      writeVoyageConfig(tmpDir, 'custom/model', stub.url);

      const { resolveEmbeddingProvider } = await import('../src/embedding-provider.js');
      const { saveEmbeddingIndex, saveStoredEmbeddingModel } = await import('../src/embeddings.js');
      const { hybridSearch } = await import('../src/search.js');
      const { createMemory } = await import('../src/memory.js');

      // The provider is built from the configured model (real resolver, no
      // interception): 'voyage:custom/model' proves 'custom/model' flowed
      // from config.json into the provider id.
      const providerId = resolveEmbeddingProvider(tmpDir).id;
      expect(providerId).toBe('voyage:custom/model');

      const entryId = 'mem_custom_model';
      const entry = createMemory('semantic-only match');
      entry.id = entryId;

      // Seed a real, in-sync embedding cache so hybridSearch's "does any
      // candidate have a cached vector" guard lets the query embed proceed.
      saveEmbeddingIndex(tmpDir, { [entryId]: [1, 0, 0] });
      saveStoredEmbeddingModel(tmpDir, providerId);

      await hybridSearch('query text', [entry], { hippoRoot: tmpDir, budget: 1000 });

      expect(stub.requests).toHaveLength(1);
      // ...and the query path embeds with role 'query' (so e5-family/
      // asymmetric models get the right input_type; symmetric models ignore it).
      expect(stub.requests[0]).toEqual({ model: 'custom/model', input: ['query text'], input_type: 'query' });
    } finally {
      await stub.close();
    }
  });

  it('treats a legacy embedding index as stale when the configured model changes', async () => {
    writeConfig(tmpDir, 'custom/model');

    const { saveEmbeddingIndex, embeddingModelRequiresReindex } = await import('../src/embeddings.js');
    saveEmbeddingIndex(tmpDir, { mem_legacy: [1, 0, 0] });

    expect(embeddingModelRequiresReindex(tmpDir, 'custom/model')).toBe(true);
  });

  it('falls back to BM25 when the embedding index needs reindexing', async () => {
    const stub = await startEmbeddingStub([1, 0, 0]);
    try {
      writeVoyageConfig(tmpDir, 'custom/model', stub.url);

      const { saveEmbeddingIndex, saveStoredEmbeddingModel } = await import('../src/embeddings.js');
      const { hybridSearch } = await import('../src/search.js');
      const { createMemory } = await import('../src/memory.js');

      // Real staleness: the cached index was built under a DIFFERENT model
      // identity than the one config.json now selects, so
      // embeddingModelRequiresReindex genuinely returns true (VOYAGE_API_KEY
      // is set, so unavailability is not why the embed gets skipped).
      saveEmbeddingIndex(tmpDir, { mem_legacy: [1, 0, 0] });
      saveStoredEmbeddingModel(tmpDir, 'voyage:some-other-model');

      const entry = createMemory('query text semantic-only match');
      const results = await hybridSearch('query text', [entry], { hippoRoot: tmpDir, budget: 1000 });

      expect(stub.requests).toHaveLength(0);
      expect(results.length).toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  });

  it('stays BM25-only on an unembedded store (no query embedding spent)', async () => {
    const stub = await startEmbeddingStub([1, 0, 0]);
    try {
      writeVoyageConfig(tmpDir, 'custom/model', stub.url);

      const { resolveEmbeddingProvider } = await import('../src/embedding-provider.js');
      const { saveStoredEmbeddingModel } = await import('../src/embeddings.js');
      const { hybridSearch } = await import('../src/search.js');
      const { createMemory } = await import('../src/memory.js');

      // In sync (no reindex needed) but genuinely empty: no embeddings.json
      // was ever written for this store, so no candidate has a cached vector.
      const providerId = resolveEmbeddingProvider(tmpDir).id;
      saveStoredEmbeddingModel(tmpDir, providerId);

      const results = await hybridSearch('query text', [createMemory('query text match')], {
        hippoRoot: tmpDir,
        budget: 1000,
      });

      // Empty index -> no cached doc vectors -> the query embedding is skipped.
      expect(stub.requests).toHaveLength(0);
      expect(results.length).toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  });
});
