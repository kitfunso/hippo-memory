/**
 * Per-model pooling dispatch test.
 *
 * `poolingFor(model)` selects the correct pooling strategy for the embedding
 * model in use:
 *   - BGE family → CLS pooling (per BAAI's `FlagEmbedding` inference code).
 *   - All others → mean pooling (sentence-transformers convention).
 *
 * Unknown model ids default to mean — the safer choice because incorrectly
 * applying CLS pooling to a mean-trained model silently degrades vector
 * quality, whereas mean pooling on a CLS-trained model degrades but at
 * least preserves enough signal for retrieval to remain functional.
 */
import { describe, it, expect } from 'vitest';
import { poolingFor, prefixFor } from '../../src/embeddings.js';

describe('embeddings: poolingFor', () => {
  it('returns "cls" for BGE-base', () => {
    expect(poolingFor('Xenova/bge-base-en-v1.5')).toBe('cls');
  });

  it('returns "cls" for BAAI/bge-base-en-v1.5 (canonical id)', () => {
    expect(poolingFor('BAAI/bge-base-en-v1.5')).toBe('cls');
  });

  it('returns "cls" for BGE variants by family-name match', () => {
    expect(poolingFor('Xenova/bge-large-en-v1.5')).toBe('cls');
    expect(poolingFor('Xenova/bge-small-en-v1.5')).toBe('cls');
    expect(poolingFor('Xenova/bge-m3')).toBe('cls');
  });

  it('returns "mean" for MiniLM (existing default model)', () => {
    expect(poolingFor('Xenova/all-MiniLM-L6-v2')).toBe('mean');
  });

  it('returns "mean" for paraphrase-multilingual-mpnet', () => {
    expect(poolingFor('Xenova/paraphrase-multilingual-mpnet-base-v2')).toBe('mean');
  });

  it('defaults to "mean" for unknown model ids', () => {
    expect(poolingFor('Xenova/some-future-model')).toBe('mean');
    expect(poolingFor('')).toBe('mean');
    expect(poolingFor('e5-large-v2')).toBe('mean');
  });

  it('returns "mean" for e5 family (sentence-transformers convention)', () => {
    expect(poolingFor('Xenova/multilingual-e5-large')).toBe('mean');
    expect(poolingFor('intfloat/multilingual-e5-large')).toBe('mean');
  });

  it('does not false-positive on substrings that contain "bge" as a non-word', () => {
    // Examples constructed to fail a naive /bge/ match if the regex did not
    // use word boundaries. None of these are real model ids, but they
    // exercise the boundary logic.
    expect(poolingFor('Xenova/abges-model')).toBe('mean');
    expect(poolingFor('Xenova/bgek-something')).toBe('mean');
  });
});

describe('embeddings: prefixFor', () => {
  it('returns empty string when role is undefined (symmetric path)', () => {
    expect(prefixFor('Xenova/multilingual-e5-large')).toBe('');
    expect(prefixFor('Xenova/bge-base-en-v1.5')).toBe('');
    expect(prefixFor('Xenova/all-MiniLM-L6-v2')).toBe('');
  });

  it('returns "query: " for e5 family with role=query', () => {
    expect(prefixFor('Xenova/multilingual-e5-large', 'query')).toBe('query: ');
    expect(prefixFor('intfloat/multilingual-e5-large', 'query')).toBe('query: ');
    expect(prefixFor('Xenova/e5-large-v2', 'query')).toBe('query: ');
  });

  it('returns "passage: " for e5 family with role=passage', () => {
    expect(prefixFor('Xenova/multilingual-e5-large', 'passage')).toBe('passage: ');
    expect(prefixFor('intfloat/multilingual-e5-large', 'passage')).toBe('passage: ');
  });

  it('returns empty string for non-e5 models regardless of role', () => {
    expect(prefixFor('Xenova/bge-base-en-v1.5', 'query')).toBe('');
    expect(prefixFor('Xenova/bge-base-en-v1.5', 'passage')).toBe('');
    expect(prefixFor('Xenova/all-MiniLM-L6-v2', 'query')).toBe('');
    expect(prefixFor('Xenova/all-MiniLM-L6-v2', 'passage')).toBe('');
  });

  it('does not false-positive on substrings that contain "e5" as a non-word', () => {
    // Guard against a naive /e5/ regex matching unrelated model ids.
    expect(prefixFor('Xenova/pe5-foo', 'query')).toBe('');
    expect(prefixFor('Xenova/e5x-bar', 'query')).toBe('');
  });
});
