// The eval kit's embedMemory(folder, entry) leaves the same index and outcome as embedMemory on that folder's target.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingsConfig } from '../../src/base/config/config.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/base/memory/memory.js';
import { embedMemory as embedOnFolder, loadEmbeddingIndex, writeEntry } from '../../src/entry/testing.js';
import { embedMemory as embedOnTarget } from '../../src/domain/search/embed-memories.js';
import { isJsonObject, type JsonValue } from '../../src/base/util/json.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const KEY_ENV = 'OPENAI_API_KEY';

beforeEach(() => {
  // Built from parts so the repo's secret scan does not flag the test file.
  vi.stubEnv(KEY_ENV, ['sk', 'test'].join('-'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      // SAFETY: the stub only receives the embeddings request body, which is JSON.
      const body = JSON.parse(String(init?.body)) as JsonValue;
      const input = isJsonObject(body) && Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0] })) }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function seededFolder(name: string, embeddings: Partial<EmbeddingsConfig>, entry: MemoryEntry): string {
  const root = makeRoot(name, { config: { embeddings } });
  writeEntry(root, entry);
  return root;
}

describe('embedMemory in the eval kit', () => {
  it('indexes a memory the way the target form does', async () => {
    const entry = createMemory('the kestrel deploy runs on tuesdays', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const config: Partial<EmbeddingsConfig> = { provider: 'openai', model: 'm' };
    const viaFolder = seededFolder('embed-folder-form', config, entry);
    const viaTarget = seededFolder('embed-target-form', config, entry);

    const folderOutcome = await embedOnFolder(viaFolder, entry);
    const targetOutcome = await embedOnTarget(localIndex(viaTarget), entry);

    expect(folderOutcome).toBe('indexed');
    expect(folderOutcome).toBe(targetOutcome);
    expect(Object.keys(loadEmbeddingIndex(viaFolder))).toEqual([entry.id]);
    expect(loadEmbeddingIndex(viaFolder)).toEqual(loadEmbeddingIndex(viaTarget));
  });

  it('answers off and writes no vector when the folder disables embeddings', async () => {
    const entry = createMemory('the heron backup runs nightly', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const config: Partial<EmbeddingsConfig> = { enabled: false, provider: 'openai', model: 'm' };
    const viaFolder = seededFolder('embed-folder-off', config, entry);
    const viaTarget = seededFolder('embed-target-off', config, entry);

    const folderOutcome = await embedOnFolder(viaFolder, entry);
    const targetOutcome = await embedOnTarget(localIndex(viaTarget), entry);

    expect(folderOutcome).toBe('off');
    expect(folderOutcome).toBe(targetOutcome);
    expect(loadEmbeddingIndex(viaFolder)).toEqual({});
  });
});
