// When hybrid search drops to BM25 only for a fixable reason, it says so once per process.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { embedMemory } from '../src/embeddings.js';
import { hybridSearch } from '../src/search.js';
import { resetLogOnce } from '../src/log.js';

const KEY_ENV = 'OPENAI_API_KEY';
let root: string;
let savedKey: string | undefined;
let stderrSpy: MockInstance<typeof process.stderr.write>;

function useModel(model: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model } }), 'utf8');
}

function fallbackLines(): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('fell back to BM25'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-bm25-fallback-'));
  initStore(root);
  useModel('m');
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'test-key-not-real';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  resetLogOnce();
});

afterEach(() => {
  vi.unstubAllGlobals();
  stderrSpy.mockRestore();
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hybridSearch BM25 fallback', () => {
  it('warns once when the index was built by another model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }))));
    const entry = createMemory('the deploy runs on fridays');
    writeEntry(root, entry);
    await embedMemory(root, entry);
    useModel('another-model');

    const entries = loadAllEntries(root);
    const first = await hybridSearch('deploy fridays', entries, { hippoRoot: root });
    await hybridSearch('deploy fridays', entries, { hippoRoot: root });

    expect(first.map((r) => r.entry.id)).toEqual([entry.id]);
    expect(fallbackLines()).toHaveLength(1);
    expect(fallbackLines()[0]).toMatch(/^\[hippo\] warn: .*hippo embed/);
  });

  it('warns once when the query embedding call throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }))));
    const entry = createMemory('the deploy runs on fridays');
    writeEntry(root, entry);
    await embedMemory(root, entry);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 500 })));

    const entries = loadAllEntries(root);
    await hybridSearch('deploy fridays', entries, { hippoRoot: root });
    await hybridSearch('deploy fridays', entries, { hippoRoot: root });

    expect(fallbackLines()).toHaveLength(1);
  });
});
