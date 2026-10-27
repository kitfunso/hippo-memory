/** A Context's store is the required store; an api or entry that reads an optional group names it in its type. */

import { describe, expectTypeOf, it } from 'vitest';
import type { Context, ContextWith, EntryContext } from '../../src/api/types.js';
import type { OptionalGroup, RequiredStore } from '../../src/base/ports/store.js';
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
    expectTypeOf<Context['store']>().toEqualTypeOf<RequiredStore>();
    expectTypeOf<Extract<keyof Context['store'], OptionalGroup>>().toEqualTypeOf<never>();
  });

  it('a Context is not a ContextWith of a group it does not name', () => {
    expectTypeOf<Context>().not.toMatchTypeOf<ContextWith<'goals'>>();
    expectTypeOf<ContextWith<'goals'>>().toMatchTypeOf<Context>();
  });

  it('the six session entries of ./server refuse a Context without sessions', () => {
    expectTypeOf<EntryContext>().not.toMatchTypeOf<Parameters<typeof bindSessionOwner>[0]>();
    expectTypeOf<EntryContext>().not.toMatchTypeOf<Parameters<typeof compactResumeForCaller>[0]>();
    expectTypeOf<EntryContext>().not.toMatchTypeOf<Parameters<typeof sessionEndHandoffForCaller>[0]>();
    expectTypeOf<EntryContext>().not.toMatchTypeOf<Parameters<typeof preCompactForCaller>[0]>();
    expectTypeOf<EntryContext>().not.toMatchTypeOf<Parameters<typeof saveCompactionItemsForCaller>[0]>();
    expectTypeOf<EntryContext>().not.toMatchTypeOf<Parameters<typeof captureFailureForCaller>[0]>();
    expectTypeOf<EntryContext<ContextWith<'sessions'>>>().toMatchTypeOf<Parameters<typeof bindSessionOwner>[0]>();
  });
});
