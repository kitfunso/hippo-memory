// A local model that cannot load must fail `hippo embed`, not report "Done. 0 new embeddings" with exit 0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { loadEmbeddingIndex } from '../src/store/vector-index.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from '../src/embeddings/provider.js';
import { handleEmbed } from '../src/cli/maintenance.js';

/** A local provider that answers every text with `vector`, or fails the whole call as an unloadable model does. */
function localProvider(opts: { available?: boolean; loadError?: string; vector?: number[] }): EmbeddingProvider {
  return {
    kind: 'local',
    model: 'load-test-model',
    id: 'load-test-model',
    isAvailable: () => opts.available ?? true,
    embed: async (texts: string[]) => {
      if (opts.loadError) throw new Error(`local embedding model did not load: ${opts.loadError}`);
      return texts.map(() => opts.vector ?? [1, 0]);
    },
  };
}

let root: string;
let emptyCache: string;
let stderr: string[];
const savedCache = process.env.HIPPO_MODEL_CACHE;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-load-'));
  emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-empty-model-cache-'));
  initStore(root);
  writeEntry(root, createMemory('the deploy runbook lives in the ops wiki', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (savedCache === undefined) delete process.env.HIPPO_MODEL_CACHE;
  else process.env.HIPPO_MODEL_CACHE = savedCache;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(emptyCache, { recursive: true, force: true });
});

describe('the local provider with a model that cannot load', () => {
  it('rejects with the reason instead of returning empty vectors', async () => {
    // An empty offline cache cannot hold the model, whether or not a transformers package is installed.
    process.env.HIPPO_MODEL_CACHE = emptyCache;
    await expect(resolveEmbeddingProvider(root).embed(['a memory'], 'passage')).rejects.toThrow(/did not load: \S/);
  });
});

describe('hippo embed exit code', () => {
  it('is 1 with the reason printed when the model cannot load', async () => {
    await handleEmbed({ hippoRoot: root, tenantId: 'default', args: [], flags: {} }, localProvider({ loadError: 'model file missing from the cache' }));
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('did not load: model file missing');
    expect(Object.keys(loadEmbeddingIndex(root))).toEqual([]);
  });

  it('is 0 when every memory is embedded', async () => {
    await handleEmbed({ hippoRoot: root, tenantId: 'default', args: [], flags: {} }, localProvider({}));
    expect(process.exitCode).toBeUndefined();
    expect(Object.keys(loadEmbeddingIndex(root))).toHaveLength(1);
  });

  it('is 1 when a memory is left unembedded', async () => {
    await handleEmbed({ hippoRoot: root, tenantId: 'default', args: [], flags: {} }, localProvider({ vector: [] }));
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('1 memories are still not embedded');
  });

  it('is 1 when no local embedding package is installed', async () => {
    await handleEmbed({ hippoRoot: root, tenantId: 'default', args: [], flags: {} }, localProvider({ available: false }));
    expect(process.exitCode).toBe(1);
  });
});
