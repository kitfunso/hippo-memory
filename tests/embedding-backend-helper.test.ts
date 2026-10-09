import { describe, it, expect, vi } from 'vitest';
import { skipWithoutEmbeddings } from './_helpers/embedding-backend.js';

describe('skipWithoutEmbeddings', () => {
  it('skips when the backend is missing and the variable is unset', () => {
    const skip = vi.fn();
    skipWithoutEmbeddings({ skip }, false, {});
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('throws an error naming the variable when the backend is missing and the variable is 1', () => {
    const skip = vi.fn();
    expect(() => skipWithoutEmbeddings({ skip }, false, { HIPPO_REQUIRE_EMBEDDINGS: '1' })).toThrow(/HIPPO_REQUIRE_EMBEDDINGS/);
    expect(skip).not.toHaveBeenCalled();
  });

  it('does nothing when the backend is present, even with the variable set', () => {
    const skip = vi.fn();
    skipWithoutEmbeddings({ skip }, true, { HIPPO_REQUIRE_EMBEDDINGS: '1' });
    expect(skip).not.toHaveBeenCalled();
  });
});
