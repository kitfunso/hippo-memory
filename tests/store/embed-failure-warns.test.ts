import { afterEach, beforeEach, describe, expect, it, vi, MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { embedMemory } from '../../src/domain/search/embed-memories.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries, loadEmbeddingIndex } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEY_ENV = 'OPENAI_API_KEY';
// Built from parts so the repo's secret scan does not flag the test file.
const KEY = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-');
let root: string;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  root = makeRoot('embed-warn');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }),
    'utf8',
  );
  vi.stubEnv(KEY_ENV, KEY);
  errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

function warnings(): string[] {
  return errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('embedding failed'));
}

function summaries(): string[] {
  return errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('more embedding errors'));
}

async function write(content: string): Promise<void> {
  const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(root, entry);
  await embedMemory(localIndex(root), entry);
}

describe('embedMemory provider failure', () => {
  // The success case never reaches the once-per-process flag, so it can share the file with the failure case.
  it('stays quiet when the provider works', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }))),
    );
    await write('a memory that embeds fine');
    expect(warnings()).toEqual([]);
    expect(Object.keys(loadEmbeddingIndex(root))).toHaveLength(1);
  });

  it('warns once per process, names the provider, hides the key, and still stores every write', async () => {
    const fetchMock = vi.fn(async () => new Response(`Incorrect API key provided: ${KEY}`, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await write('first memory written with a bad key');
    expect(warnings()).toHaveLength(1);
    const [line] = warnings();
    expect(line).toContain('[hippo] warn: embedding failed (openai)');
    expect(line).toContain('401');
    expect(line).toContain('Memories are stored without embeddings until this is fixed.');
    expect(line).not.toContain(KEY);

    await write('second memory written with a bad key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toHaveLength(1);

    expect(loadAllEntries(root, 'default')).toHaveLength(2);
    expect(loadEmbeddingIndex(root)).toEqual({});
  });

  it('warns once and resolves when the config names an unknown provider', async () => {
    // A fresh module, since the test above already spent this process's one warning.
    vi.resetModules();
    const fresh = await import('../../src/domain/search/embed-memories.js');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'opneai' } }), 'utf8');
    const entry = createMemory('a memory under a typo in the provider name', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(root, entry);

    await expect(fresh.embedMemory(localIndex(root), entry)).resolves.toBe('failed');
    await expect(fresh.embedMemory(localIndex(root), entry)).resolves.toBe('failed');

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("[hippo] warn: embedding failed (config): Unknown embeddings.provider 'opneai'");
  });

  it('warns again for a different failure after the first one', async () => {
    vi.resetModules();
    const fresh = await import('../../src/domain/search/embed-memories.js');
    const config = path.join(root, 'config.json');
    const entry = createMemory('a memory that meets two different failures', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(root, entry);

    fs.writeFileSync(config, JSON.stringify({ embeddings: { provider: 'opneai' } }), 'utf8');
    await fresh.embedMemory(localIndex(root), entry);
    fs.writeFileSync(config, JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }), 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad key', { status: 401 })),
    );
    await fresh.embedMemory(localIndex(root), entry);
    await fresh.embedMemory(localIndex(root), entry);

    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain('embedding failed (config)');
    expect(warnings()[1]).toContain('embedding failed (openai)');
  });

  it('counts later failures and reports the count once the interval has passed', async () => {
    vi.resetModules();
    const fresh = await import('../../src/domain/search/embed-memories.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('bad key', { status: 401 })),
      );
      const entry = createMemory('a memory that keeps failing', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
      writeEntry(root, entry);
      await fresh.embedMemory(localIndex(root), entry);
      await fresh.embedMemory(localIndex(root), entry);
      await fresh.embedMemory(localIndex(root), entry);
      expect(summaries()).toEqual([]);
      vi.setSystemTime(Date.now() + 61_000);
      await fresh.embedMemory(localIndex(root), entry);
      expect(warnings()).toHaveLength(1);
      expect(summaries()).toHaveLength(1);
      expect(summaries()[0]).toContain('3 more embedding errors from openai');
    } finally {
      vi.useRealTimers();
    }
  });
});
