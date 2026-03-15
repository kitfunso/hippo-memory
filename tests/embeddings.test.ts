import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/embeddings.js';

// ---------------------------------------------------------------------------
// Tests that run without @xenova/transformers installed
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
  it('returns a boolean', async () => {
    const { isEmbeddingAvailable } = await import('../src/embeddings.js');
    const available = await isEmbeddingAvailable();
    expect(typeof available).toBe('boolean');
    // We don't assert true/false since the test env may or may not have the lib
  });
});

// ---------------------------------------------------------------------------
// loadEmbeddingIndex / saveEmbeddingIndex
// ---------------------------------------------------------------------------

describe('embedding index persistence', () => {
  it('round-trips an index via save + load', async () => {
    const { loadEmbeddingIndex, saveEmbeddingIndex } = await import('../src/embeddings.js');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-'));
    // We need the .hippo structure; here we just use tmpDir directly as root
    const index: Record<string, number[]> = {
      mem_abc: [0.1, 0.2, 0.3],
      mem_def: [0.4, 0.5, 0.6],
    };

    saveEmbeddingIndex(tmpDir, index);
    const loaded = loadEmbeddingIndex(tmpDir);

    expect(loaded['mem_abc']).toEqual([0.1, 0.2, 0.3]);
    expect(loaded['mem_def']).toEqual([0.4, 0.5, 0.6]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when index file does not exist', async () => {
    const { loadEmbeddingIndex } = await import('../src/embeddings.js');
    const loaded = loadEmbeddingIndex('/tmp/hippo-nonexistent-' + Date.now());
    expect(loaded).toEqual({});
  });
});
