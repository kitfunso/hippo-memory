/** The types an integrator sees from `hippo-memory` (src/index.ts); a drift fails `npm run typecheck:tests`. */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  applyOutcome,
  calculateStrength,
  consolidate,
  createMemory,
  estimateTokens,
  generateId,
  hybridSearch,
  search,
  sleep,
  textOverlap,
  tokenize,
  type MemoryEntry,
  type SearchResult,
  type SleepOpts,
  type SleepResult,
} from '../../src/index.js';
import type { Context } from '../../src/api/types.js';
import type {
  RecallBoostOptions,
  RecallFilterOptions,
  RecallHintOptions,
  RecallOptions,
  RecallTraceOptions,
  RecallWindowOptions,
} from '../../src/api/index.js';
import type { ConsolidationResult } from '../../src/consolidate/run.js';
import type { HippoStore } from '../../src/entry/store-kit.js';

describe('hippo-memory entry types', () => {
  it('createMemory takes content then optional partial options and returns a MemoryEntry', () => {
    expectTypeOf(createMemory).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(createMemory).returns.toEqualTypeOf<MemoryEntry>();
    // @ts-expect-error content is a string, not an options object
    typeOnly(() => createMemory({ content: 'x' }));
    expect(createMemory('typed entry').content).toBe('typed entry');
  });

  it('search is synchronous and takes the query before the entries', () => {
    expectTypeOf(search).parameters.toMatchTypeOf<[string, MemoryEntry[], ...unknown[]]>();
    expectTypeOf(search).returns.toEqualTypeOf<SearchResult[]>();
    // @ts-expect-error entries come after the query
    typeOnly(() => search([], 'query'));
  });

  it('hybridSearch is async and resolves to SearchResult[]', () => {
    expectTypeOf(hybridSearch).returns.toEqualTypeOf<Promise<SearchResult[]>>();
    // @ts-expect-error the query is required
    typeOnly(() => hybridSearch());
  });

  it('strength and outcome helpers pin their scalar types', () => {
    expectTypeOf(calculateStrength).returns.toEqualTypeOf<number>();
    expectTypeOf(applyOutcome).parameters.toEqualTypeOf<[MemoryEntry, boolean]>();
    expectTypeOf(applyOutcome).returns.toEqualTypeOf<MemoryEntry>();
    // @ts-expect-error the outcome is a boolean
    typeOnly(() => applyOutcome(createMemory('x'), 'good'));
  });

  it('text helpers take strings', () => {
    expectTypeOf(generateId).returns.toEqualTypeOf<string>();
    expectTypeOf(estimateTokens).toEqualTypeOf<(text: string) => number>();
    expectTypeOf(tokenize).toEqualTypeOf<(text: string) => string[]>();
    expectTypeOf(textOverlap).toEqualTypeOf<(a: string, b: string) => number>();
  });

  it('consolidate and sleep are async', () => {
    expectTypeOf(consolidate).parameter(0).toEqualTypeOf<string | HippoStore>();
    expectTypeOf(consolidate).returns.toEqualTypeOf<Promise<ConsolidationResult>>();
    expectTypeOf(sleep).parameter(0).toEqualTypeOf<Context>();
    expectTypeOf(sleep).parameter(1).toEqualTypeOf<SleepOpts | undefined>();
    expectTypeOf(sleep).returns.toEqualTypeOf<Promise<SleepResult>>();
    // @ts-expect-error sleep needs a Context, not a root path
    typeOnly(() => sleep('/tmp/root'));
  });
});

describe('api barrel recall types', () => {
  it('RecallOptions keeps the query at the top and groups the rest by stage', () => {
    expectTypeOf<RecallOptions['query']>().toEqualTypeOf<string>();
    expectTypeOf<RecallOptions['window']>().toEqualTypeOf<RecallWindowOptions | undefined>();
    expectTypeOf<RecallOptions['filter']>().toEqualTypeOf<RecallFilterOptions | undefined>();
    expectTypeOf<RecallOptions['boost']>().toEqualTypeOf<RecallBoostOptions | undefined>();
    expectTypeOf<RecallOptions['hints']>().toEqualTypeOf<RecallHintOptions | undefined>();
    expectTypeOf<RecallOptions['trace']>().toEqualTypeOf<RecallTraceOptions | undefined>();
    const grouped: RecallOptions = { query: 'q', window: { limit: 3 }, filter: { scope: 'team' } };
    // @ts-expect-error limit moved into window in 3.0
    const flat: RecallOptions = { query: 'q', limit: 3 };
    expect([grouped.window?.limit, flat.query]).toEqual([3, 'q']);
  });
});
