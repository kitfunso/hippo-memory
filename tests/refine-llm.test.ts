import { describe, it, expect } from 'vitest';
import { refineSemanticMemory, refineStore } from '../src/refine-llm.js';
import { createMemory, Layer } from '../src/memory.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
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
  return (async () => ({
    ok,
    status: ok ? 200 : 500,
    async json() { return { content: [{ text: body }] }; },
    async text() { return JSON.stringify({ content: [{ text: body }] }); },
  })) as unknown as typeof fetch;
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

  it('returns null on API error', async () => {
    const fetcher = mockFetcher('ignored', false);
    const result = await refineSemanticMemory('merged', [], { apiKey: 'test', fetcher });
    expect(result).toBeNull();
  });

  it('returns null on too-short response', async () => {
    const fetcher = mockFetcher('ok');
    const result = await refineSemanticMemory('merged', [], { apiKey: 'test', fetcher });
    expect(result).toBeNull();
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
