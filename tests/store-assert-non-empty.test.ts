/**
 * v1.7.3 — runtime test for the module-load throw path on
 * RECALL_DEFAULT_DENY_SCOPES. Codex P1-3 from v1.7.2 review.
 *
 * The inline guard fires on module import; direct testing of the constant
 * is impossible (the throw runs before any test code). The guard is
 * extracted as `assertNonEmpty(arr, name)` and tested here directly.
 */

import { describe, it, expect } from 'vitest';
import { assertNonEmpty } from '../src/store.js';

describe('assertNonEmpty (v1.7.3 review-tail)', () => {
  it('throws when array is empty', () => {
    expect(() => assertNonEmpty([], 'TEST_CONST')).toThrow(
      /TEST_CONST cannot be empty/,
    );
  });

  it('does not throw when array has at least one element', () => {
    expect(() => assertNonEmpty(['x'], 'TEST_CONST')).not.toThrow();
  });

  it('handles readonly arrays without widening at the call site', () => {
    const arr = ['unknown:legacy'] as const;
    expect(() => assertNonEmpty(arr as readonly string[], 'TEST')).not.toThrow();
  });
});
