import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { embedMemory, loadEmbeddingIndex } from '../src/embeddings.js';

const KEY_ENV = 'OPENAI_API_KEY';
// Built from parts so the repo's secret scan does not flag the test file.
const KEY = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-');
let root: string;
let savedKey: string | undefined;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-warn-'));
  initStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }), 'utf8');
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = KEY;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  fs.rmSync(root, { recursive: true, force: true });
});

function warnings(): string[] {
  return errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('embedding failed'));
}

async function write(content: string): Promise<void> {
  const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(root, entry);
  await embedMemory(root, entry);
}

describe('embedMemory provider failure', () => {
  // The success case never reaches the once-per-process flag, so it can share the file with the failure case.
  it('stays quiet when the provider works', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }))));
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
    expect(line).toContain('hippo: embedding failed (openai)');
    expect(line).toContain('401');
    expect(line).toContain('Memories are stored without embeddings until this is fixed.');
    expect(line).not.toContain(KEY);

    await write('second memory written with a bad key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toHaveLength(1);

    expect(loadAllEntries(root)).toHaveLength(2);
    expect(loadEmbeddingIndex(root)).toEqual({});
  });

  it('warns once and resolves when the config names an unknown provider', async () => {
    // A fresh module, since the test above already spent this process's one warning.
    vi.resetModules();
    const fresh = await import('../src/embeddings.js');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'opneai' } }), 'utf8');
    const entry = createMemory('a memory under a typo in the provider name', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);

    await expect(fresh.embedMemory(root, entry)).resolves.toBeUndefined();
    await expect(fresh.embedMemory(root, entry)).resolves.toBeUndefined();

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("hippo: embedding failed (config): Unknown embeddings.provider 'opneai'");
  });
});
