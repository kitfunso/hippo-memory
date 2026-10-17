/**
 * v1.7.3 — runtime test for the module-load throw path on
 * RECALL_DEFAULT_DENY_SCOPES. Codex P1-3 from v1.7.2 review.
 *
 * The inline guard fires on module import; direct testing of the constant
 * is impossible (the throw runs before any test code). The guard is
 * extracted as `assertNonEmpty(arr, name)` and tested here directly.
 */

import { describe, it, expect } from 'vitest';
import { assertNonEmpty, RECALL_DEFAULT_DENY_SCOPES } from '../src/core/recall-scope.js';

const thrownBy = (fn: () => void): Error | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  return undefined;
};

describe('assertNonEmpty', () => {
  it('throws an Error that names the constant when the array is empty', () => {
    const error = thrownBy(() => assertNonEmpty([], 'TEST_CONST'));
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/^TEST_CONST cannot be empty/);
  });

  it('returns nothing and leaves the array alone when it has an element', () => {
    const arr = ['x'];
    expect(thrownBy(() => assertNonEmpty(arr, 'TEST_CONST'))).toBeUndefined();
    expect(assertNonEmpty(arr, 'TEST_CONST')).toBeUndefined();
    expect(arr).toEqual(['x']);
  });

  it('handles readonly arrays without widening at the call site', () => {
    const arr = ['unknown:legacy'] as const;
    expect(thrownBy(() => assertNonEmpty(arr, 'TEST'))).toBeUndefined();
  });

  it('the shipped deny list passed the guard at import and holds the legacy scope', () => {
    expect(RECALL_DEFAULT_DENY_SCOPES).toEqual(['unknown:legacy']);
  });
});
