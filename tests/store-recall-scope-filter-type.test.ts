/**
 * v1.7.2 T1 — RecallScopeFilter discriminated union contract.
 *
 * Pre-T1: `loadSearchRows::recallScope?: { value: string | null }` (boxed
 * nullable). Foot-gun: `{ value: undefined }` would bind `m.scope = undefined`.
 * T1: replace with discriminated union exported as RecallScopeFilter.
 * Public `loadRecallSearchEntries(requestedScope?: string)` shape unchanged.
 */

import { describe, it, expect } from 'vitest';
import type { RecallScopeFilter } from '../src/store.js';

describe('RecallScopeFilter discriminated union (v1.7.2 T1)', () => {
  it('default-deny construction is type-safe', () => {
    const f: RecallScopeFilter = { mode: 'default-deny' };
    expect(f.mode).toBe('default-deny');
  });

  it('exact construction requires value (narrowing works)', () => {
    const f: RecallScopeFilter = { mode: 'exact', value: 'unknown:legacy' };
    expect(f.mode).toBe('exact');
    if (f.mode === 'exact') {
      // Narrowing must give us .value here without a cast.
      expect(f.value).toBe('unknown:legacy');
    }
  });
});
