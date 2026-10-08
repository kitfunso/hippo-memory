import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from 'vitest';
import { refineSemanticMemory, refineStore } from '../src/refine-llm.js';
import { Layer} from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-refine-'));
  initStore(dir);
  return dir;
}
function cleanup(dir: string): void { fs.rmSync(dir, { recursive: true, force: true }); }

/** A fetch stub that returns a canned Claude-shaped JSON response. */
function mockFetcher(body: string, ok = true): typeof fetch {
  const status = ok ? 200 : 500;
  // A real Response satisfies `typeof fetch`'s return type directly, so no
  // assertion is needed: .ok is derived from `status`, .json()/.text() work
  // as usual.
  return async () => new Response(JSON.stringify({ content: [{ text: body }] }), { status });
}

describe('refineSemanticMemory', () => {
  it('returns the refined text from a successful API response', async () => {
    const fetcher = mockFetcher('Prefer async over sync in production paths.');
    const result = await refineSemanticMemory(
      '[Consolidated from 3 related memories]\n\nuse async ... use async ... use async',
      [],
      { apiKey: 'test', fetcher },
    );
    expect(result).toBe('Prefer async over sync in production paths.');
  });

  describe('failure logging', () => {
    const API_KEY = 'refine-test-key-0000';
    let stderr: MockInstance<typeof process.stderr.write>;
    const warnLines = (): string[] => stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('refine'));
    beforeEach(() => { stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
    afterEach(() => { stderr.mockRestore(); });

    it.each([
      ['the request throws', async (): Promise<Response> => { throw new Error('socket hang up'); }, /request failed: socket hang up/],
      ['the API answers non-2xx', async (): Promise<Response> => new Response('{"error":"bad"}', { status: 400 }), /HTTP 400/],
      ['the body is not JSON', async (): Promise<Response> => new Response('not json', { status: 200 }), /unreadable response/],
      ['the reply is too short', async (): Promise<Response> => new Response(JSON.stringify({ content: [{ text: 'ok' }] }), { status: 200 }), /empty or too short/],
    ])('returns null and logs one warning when %s', async (_label, fetcher, pattern) => {
      const result = await refineSemanticMemory('merged', [], { apiKey: API_KEY, fetcher });
      expect(result).toBeNull();
      const lines = warnLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[hippo\] warn: refine: /);
      expect(lines[0]).toMatch(pattern);
      expect(lines.join('')).not.toContain(API_KEY);
    });
  });
});

describe('refineStore', () => {
  it('refines consolidated semantic memories and tags them llm-refined', async () => {
    const dir = tmpStore();
    try {
      const semantic = createMemory(
        '[Consolidated from 2 related memories]\n\nOriginal clumsy merged content here',
        { layer: Layer.Semantic, tags: ['test'] },
      );
      writeEntry(dir, semantic);

      const fetcher = mockFetcher('Clean refined summary.');
      const result = await refineStore(dir, { apiKey: 'test', fetcher });

      expect(result.scanned).toBe(1);
      expect(result.refined).toBe(1);
      expect(result.skipped).toBe(0);

      const updated = readEntry(dir, semantic.id);
      expect(updated?.content).toBe('Clean refined summary.');
      expect(updated?.tags).toContain('llm-refined');
    } finally { cleanup(dir); }
  });

  it('skips already-refined memories (idempotent)', async () => {
    const dir = tmpStore();
    try {
      const semantic = createMemory(
        '[Consolidated from 2 related memories]\n\nsome content',
        { layer: Layer.Semantic, tags: ['llm-refined'] },
      );
      writeEntry(dir, semantic);

      const fetcher = mockFetcher('would-be refined');
      const result = await refineStore(dir, { apiKey: 'test', fetcher });

      expect(result.scanned).toBe(1);
      expect(result.refined).toBe(0);
      expect(result.skipped).toBe(1);

      const untouched = readEntry(dir, semantic.id);
      expect(untouched?.content).toContain('[Consolidated from');
    } finally { cleanup(dir); }
  });

  it('--all flag forces re-refinement of tagged memories', async () => {
    const dir = tmpStore();
    try {
      const semantic = createMemory(
        '[Consolidated from 2 related memories]\n\nsome content',
        { layer: Layer.Semantic, tags: ['llm-refined'] },
      );
      writeEntry(dir, semantic);

      const fetcher = mockFetcher('new refined content');
      const result = await refineStore(dir, { apiKey: 'test', fetcher, all: true });

      expect(result.refined).toBe(1);
      expect(readEntry(dir, semantic.id)?.content).toBe('new refined content');
    } finally { cleanup(dir); }
  });

  it('dry-run does not write refinements', async () => {
    const dir = tmpStore();
    try {
      const semantic = createMemory(
        '[Consolidated from 2 related memories]\n\nunchanged content',
        { layer: Layer.Semantic },
      );
      writeEntry(dir, semantic);

      const fetcher = mockFetcher('would-be new content');
      const result = await refineStore(dir, { apiKey: 'test', fetcher, dryRun: true });

      expect(result.refined).toBe(1);
      expect(readEntry(dir, semantic.id)?.content).toContain('[Consolidated from');
      expect(readEntry(dir, semantic.id)?.tags).not.toContain('llm-refined');
    } finally { cleanup(dir); }
  });

  it('ignores non-semantic and non-consolidated memories', async () => {
    const dir = tmpStore();
    try {
      const episodic = createMemory('regular episodic memory', { layer: Layer.Episodic });
      const plainSemantic = createMemory('a plain semantic memory with no consolidation marker', {
        layer: Layer.Semantic,
      });
      writeEntry(dir, episodic);
      writeEntry(dir, plainSemantic);

      const fetcher = mockFetcher('nope');
      const result = await refineStore(dir, { apiKey: 'test', fetcher });

      expect(result.scanned).toBe(0);
      expect(result.refined).toBe(0);
    } finally { cleanup(dir); }
  });

  it('counts API failures separately from skips', async () => {
    const dir = tmpStore();
    try {
      const semantic = createMemory(
        '[Consolidated from 2 related memories]\n\ncontent that will fail',
        { layer: Layer.Semantic },
      );
      writeEntry(dir, semantic);

      const fetcher = mockFetcher('ignored', false); // API error
      const result = await refineStore(dir, { apiKey: 'test', fetcher });

      expect(result.scanned).toBe(1);
      expect(result.refined).toBe(0);
      expect(result.failed).toBe(1);
      // Untouched on failure
      expect(readEntry(dir, semantic.id)?.content).toContain('[Consolidated from');
    } finally { cleanup(dir); }
  });
});
