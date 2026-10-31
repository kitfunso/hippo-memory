/** A Context's store is the core store; a published entry on hippo.db's local tier takes it as is and proves the
 * tier at run time. */

import { describe, expectTypeOf, it } from 'vitest';
import type { Context, ContextWith, EntryContext } from '../../src/api/types.js';
import type { OptionalGroup, HippoStore } from '../../src/base/ports/store.js';
import {
  bindSessionOwner,
  captureFailureForCaller,
  compactResumeForCaller,
  preCompactForCaller,
  saveCompactionItemsForCaller,
  sessionEndHandoffForCaller,
} from '../../src/server.js';

describe('Context store groups', () => {
  it("Context['store'] is the required store, with no optional group on it", () => {
    expectTypeOf<Context['store']>().toEqualTypeOf<HippoStore>();
    expectTypeOf<Extract<keyof Context['store'], OptionalGroup>>().toEqualTypeOf<never>();
  });

  it('a Context is not a ContextWith of a group it does not name', () => {
    expectTypeOf<Context>().not.toMatchTypeOf<ContextWith<'goals'>>();
    expectTypeOf<ContextWith<'goals'>>().toMatchTypeOf<Context>();
  });

  it('the session entries of ./server take the published Context, which names no local tier', () => {
    expectTypeOf(bindSessionOwner).parameter(0).toEqualTypeOf<EntryContext>();
    expectTypeOf(compactResumeForCaller).parameter(0).toEqualTypeOf<EntryContext>();
    expectTypeOf(sessionEndHandoffForCaller).parameter(0).toEqualTypeOf<EntryContext>();
    expectTypeOf(preCompactForCaller).parameter(0).toEqualTypeOf<EntryContext>();
    expectTypeOf(saveCompactionItemsForCaller).parameter(0).toEqualTypeOf<EntryContext>();
    expectTypeOf(captureFailureForCaller).parameter(0).toEqualTypeOf<EntryContext>();
    expectTypeOf<Extract<keyof EntryContext['store'], 'hippoDb'>>().toEqualTypeOf<never>();
  });
});
