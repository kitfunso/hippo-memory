// A corrupt legacy embeddings.json found at import must be kept aside and the vectors rebuilt, never dropped silently.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { embedMemory, embedAll, loadEmbeddingIndex } from '../src/store/embeddings/index.js';

const KEY_ENV = 'OPENAI_API_KEY';
let root: string;
let savedKey: string | undefined;
let stderrSpy: MockInstance<typeof process.stderr.write>;

// One vector per input, derived from the text so each memory gets a distinct one.
function fakeEmbeddings(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: { body: string }) => {
    // SAFETY: the OpenAI provider's buildBody always sends `{ model, input: texts }`.
    const { input } = JSON.parse(init.body) as { input: string[] };
    const data = input.map((t) => ({ embedding: [t.length, 1] }));
    return new Response(JSON.stringify({ data }));
  });
}

function asideFiles(): string[] {
  return fs.readdirSync(root).filter((f) => f.startsWith('embeddings.json.corrupt-'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-corrupt-'));
  initStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }), 'utf8');
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'test-key-not-real';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubGlobal('fetch', fakeEmbeddings());
});

afterEach(() => {
  vi.unstubAllGlobals();
  stderrSpy.mockRestore();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  fs.rmSync(root, { recursive: true, force: true });
});

async function remember(content: string): Promise<string> {
  const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(root, entry);
  await embedMemory(root, entry);
  return entry.id;
}

describe('corrupt embeddings.json at import', () => {
  it('keeps the corrupt file aside and a later remember leaves every memory with a vector', async () => {
    const first = await remember('the deploy runs on fridays');
    const second = await remember('staging uses the blue cluster');
    expect(Object.keys(loadEmbeddingIndex(root)).sort()).toEqual([first, second].sort());

    const fp = path.join(root, 'embeddings.json');
    const corrupt = '{"mem_cut": [0.1, 0.';
    fs.writeFileSync(fp, corrupt, 'utf8');

    const third = await remember('rollbacks need a ticket');

    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, aside[0]!), 'utf8')).toBe(corrupt);
    expect(fs.existsSync(fp)).toBe(false);
    expect(Object.keys(loadEmbeddingIndex(root)).sort()).toEqual([first, second, third].sort());
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('embeddings.json'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('[hippo] error:');
  });

  it('a read alone moves the file aside and the next embed run rebuilds every vector', async () => {
    const first = await remember('the deploy runs on fridays');
    const fp = path.join(root, 'embeddings.json');
    fs.writeFileSync(fp, 'null', 'utf8');

    expect(Object.keys(loadEmbeddingIndex(root))).toEqual([first]);
    expect(fs.existsSync(fp)).toBe(false);
    expect(asideFiles()).toHaveLength(1);

    expect(await embedAll(root)).toBe(1);
    expect(Object.keys(loadEmbeddingIndex(root))).toEqual([first]);
    expect(asideFiles()).toHaveLength(1);
  });
});
