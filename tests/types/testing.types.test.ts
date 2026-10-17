/** The types an integrator sees from `hippo-memory/testing` (src/entry/testing.ts): reset seams that take nothing. */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import * as testing from '../../src/entry/testing.js';

describe('hippo-memory/testing entry types', () => {
  it('the reset helpers take no arguments and return nothing', () => {
    expectTypeOf(testing._resetAblationCacheForTests).toEqualTypeOf<() => void>();
    expectTypeOf(testing._resetSharedStoreCacheForTests).toEqualTypeOf<() => void>();
    expectTypeOf(testing._resetLossAversionRatioCacheForTests).toEqualTypeOf<() => void>();
    expectTypeOf(testing._resetProjectIdentityCacheForTests).toEqualTypeOf<() => void>();
    expectTypeOf(testing._resetLogOnceForTests).toEqualTypeOf<() => void>();
    expectTypeOf(testing._resetSessionRecallHistoryMcpForTests).toEqualTypeOf<() => void>();
    expectTypeOf(testing.__resetSessionRecallHistoryHttp).toEqualTypeOf<() => void>();
  });

  it('a reset helper rejects an argument', () => {
    // @ts-expect-error the seam takes no arguments
    typeOnly(() => testing._resetLogOnceForTests('x'));
  });

  it('the entry exports exactly the nine published seams', () => {
    expectTypeOf<keyof typeof testing>().toEqualTypeOf<
      | '_resetAblationCacheForTests' | '_setDigestExistsProbeForTests' | '_resetSharedStoreCacheForTests'
      | '_resetLossAversionRatioCacheForTests' | '_resetProjectIdentityCacheForTests'
      | '_resetSessionRecallHistoryMcpForTests' | '__resetSessionRecallHistoryHttp'
      | '_readApiKeyVerifyStatsForTests' | '_resetLogOnceForTests'
    >();
    expect(Object.keys(testing)).toHaveLength(9);
  });
});
