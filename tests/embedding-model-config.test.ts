import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function writeConfig(hippoRoot: string, model: string): void {
  fs.writeFileSync(
    path.join(hippoRoot, 'config.json'),
    JSON.stringify({ embeddings: { model } }, null, 2),
    'utf8',
  );
}

describe('embedding model configuration', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    vi.unmock('../src/embeddings.js');
    vi.unmock('../src/search.js');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-model-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves the configured embedding model when no explicit override is provided', async () => {
    writeConfig(tmpDir, 'custom/model');

    const embeddings = await import('../src/embeddings.js') as typeof import('../src/embeddings.js') & {
      resolveEmbeddingModel?: (hippoRoot: string, explicitModel?: string) => string;
    };

    expect(typeof embeddings.resolveEmbeddingModel).toBe('function');
    expect(embeddings.resolveEmbeddingModel?.(tmpDir)).toBe('custom/model');
  });

  it('hybridSearch passes the configured model to getEmbedding', async () => {
    writeConfig(tmpDir, 'custom/model');

    const getEmbeddingMock = vi.fn(async () => [1, 0, 0]);
    const entryId = 'mem_custom_model';

    vi.doMock('../src/embeddings.js', async () => {
      const actual = await vi.importActual<typeof import('../src/embeddings.js')>('../src/embeddings.js');
      return {
        ...actual,
        isEmbeddingAvailable: () => true,
        getEmbedding: getEmbeddingMock,
        embeddingModelRequiresReindex: () => false,
        loadEmbeddingIndex: () => ({ [entryId]: [1, 0, 0] }),
        cosineSimilarity: () => 1,
      };
    });

    const { hybridSearch } = await import('../src/search.js');
    const { createMemory } = await import('../src/memory.js');

    const entry = createMemory('semantic-only match');
    entry.id = entryId;

    await hybridSearch('query text', [entry], { hippoRoot: tmpDir, budget: 1000 });

    expect(getEmbeddingMock).toHaveBeenCalledWith('query text', 'custom/model');
  });

  it('treats a legacy embedding index as stale when the configured model changes', async () => {
    writeConfig(tmpDir, 'custom/model');

    const { saveEmbeddingIndex, embeddingModelRequiresReindex } =
      await vi.importActual<typeof import('../src/embeddings.js')>('../src/embeddings.js');
    saveEmbeddingIndex(tmpDir, { mem_legacy: [1, 0, 0] });

    expect(embeddingModelRequiresReindex(tmpDir, 'custom/model')).toBe(true);
  });

  it('falls back to BM25 when the embedding index needs reindexing', async () => {
    writeConfig(tmpDir, 'custom/model');

    const getEmbeddingMock = vi.fn(async () => [1, 0, 0]);

    vi.doMock('../src/embeddings.js', async () => {
      const actual = await vi.importActual<typeof import('../src/embeddings.js')>('../src/embeddings.js');
      return {
        ...actual,
        isEmbeddingAvailable: () => true,
        embeddingModelRequiresReindex: () => true,
        getEmbedding: getEmbeddingMock,
        loadEmbeddingIndex: () => ({ mem_legacy: [1, 0, 0] }),
      };
    });

    const { hybridSearch } = await import('../src/search.js');
    const { createMemory } = await import('../src/memory.js');

    const entry = createMemory('query text semantic-only match');
    const results = await hybridSearch('query text', [entry], { hippoRoot: tmpDir, budget: 1000 });

    expect(getEmbeddingMock).not.toHaveBeenCalled();
    expect(results.length).toBeGreaterThan(0);
  });
});
