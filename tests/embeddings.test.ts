import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cosineSimilarity } from '../src/store/embeddings/index.js';
import { REQUIRE_EMBEDDINGS_VAR } from './_helpers/embedding-backend.js';

const LOCAL_JS = new URL('../dist/store/embeddings/local.js', import.meta.url).href;
const INSTALLED_ONLY = fileURLToPath(new URL('./_helpers/transformers-installed.cjs', import.meta.url));

// ---------------------------------------------------------------------------
// Tests that run without a Transformers.js backend installed
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('handles zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('returns partial similarity for related vectors', () => {
    const a = [1, 1, 0];
    const b = [1, 0, 0];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// isEmbeddingAvailable - should return false without the library
// ---------------------------------------------------------------------------

describe('isEmbeddingAvailable', () => {
  const TRANSFORMERS = ['@xenova/transformers', '@huggingface/transformers'];

  /** What the built local.js answers in a fresh node that can resolve only `installed` of the two packages. */
  function availableWith(installed: readonly string[]): string {
    const script = `import(${JSON.stringify(LOCAL_JS)}).then((m) => process.stdout.write(String(m.isEmbeddingAvailable())))`;
    return execFileSync(process.execPath, ['--require', INSTALLED_ONLY, '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TRANSFORMERS_INSTALLED: installed.join(',') },
    });
  }

  it('is false with neither package installed and true with either one', () => {
    expect(availableWith([])).toBe('false');
    expect(availableWith(['@huggingface/transformers'])).toBe('true');
    expect(availableWith(['@xenova/transformers'])).toBe('true');
  });

  it('matches what this install resolves, and is true on the CI leg that requires the backend', async () => {
    const { isEmbeddingAvailable } = await import('../src/store/embeddings/local.js');
    const req = createRequire(import.meta.url);
    const resolves = (id: string): boolean => {
      try {
        req.resolve(id);
        return true;
      } catch {
        return false;
      }
    };
    expect(isEmbeddingAvailable()).toBe(TRANSFORMERS.some(resolves));
    if (process.env[REQUIRE_EMBEDDINGS_VAR] === '1') expect(isEmbeddingAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadEmbeddingIndex / saveEmbeddingIndex
// ---------------------------------------------------------------------------

describe('embedding index persistence', () => {
  it('round-trips an index via save + load', async () => {
    const { loadEmbeddingIndex, saveEmbeddingIndex } = await import('../src/store/vector-index.js');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-'));
    // We need the .hippo structure; here we just use tmpDir directly as root
    const index = {
      mem_abc: [0.1, 0.2, 0.3],
      mem_def: [0.4, 0.5, 0.6],
    } satisfies Record<string, number[]>;

    saveEmbeddingIndex(tmpDir, index);
    const loaded = loadEmbeddingIndex(tmpDir);

    // Vectors are stored as float32.
    expect(loaded['mem_abc']).toEqual([0.1, 0.2, 0.3].map(Math.fround));
    expect(loaded['mem_def']).toEqual([0.4, 0.5, 0.6].map(Math.fround));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when index file does not exist', async () => {
    const { loadEmbeddingIndex } = await import('../src/store/vector-index.js');
    const loaded = loadEmbeddingIndex('/tmp/hippo-nonexistent-' + Date.now());
    expect(loaded).toEqual({});
  });
});
