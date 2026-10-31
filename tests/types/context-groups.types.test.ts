/** A Context's store is the core store; a published entry on hippo.db's local tier takes it as is and proves the
 * tier at run time. */

import { describe, expectTypeOf, it } from 'vitest';
import type { Context, EntryContext } from '../../src/api/types.js';
import type { HippoDbContext } from '../../src/api/hippo-db-context.js';
import type { CoreGroups, HippoStore } from '../../src/base/ports/store.js';
import {
  bindSessionOwner,
  captureFailureForCaller,
  compactResumeForCaller,
  preCompactForCaller,
  saveCompactionItemsForCaller,
  sessionEndHandoffForCaller,
} from '../../src/server.js';

describe('Context store groups', () => {
  it("Context['store'] is the core store: the six core groups and no local tier", () => {
    expectTypeOf<Context['store']>().toEqualTypeOf<HippoStore>();
    expectTypeOf<keyof CoreGroups>().toEqualTypeOf<
      'keyWrites' | 'entryWrites' | 'contextReads' | 'auditLog' | 'vectors' | 'vectorWrites'
    >();
    expectTypeOf<Extract<keyof Context['store'], 'hippoDb'>>().toEqualTypeOf<never>();
  });

  it('a Context is not a HippoDbContext, and a HippoDbContext is a Context', () => {
    expectTypeOf<Context>().not.toMatchTypeOf<HippoDbContext>();
    expectTypeOf<HippoDbContext>().toMatchTypeOf<Context>();
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
