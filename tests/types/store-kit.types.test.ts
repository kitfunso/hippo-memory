/** The types an integrator sees from `hippo-memory/store-kit` (src/entry/store-kit.ts), the contract for a second store. */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  RejectedValueError, entryAfterOutcome, hasGroup, requireGroup, sqliteStore,
  type HippoStore, type MemoryEntry, type OptionalGroup, type StoreGroup, type StoreGroups, type SupersedeWrite,
} from '../../src/entry/store-kit.js';

declare const store: HippoStore;

describe('hippo-memory/store-kit entry types', () => {
  it('sqliteStore takes a root path and returns a store with every optional group', () => {
    expectTypeOf(sqliteStore).parameters.toEqualTypeOf<[hippoRoot: string]>();
    expectTypeOf(sqliteStore).returns.toEqualTypeOf<HippoStore & StoreGroups>();
    // @ts-expect-error the root is a path string
    typeOnly(() => sqliteStore({ hippoRoot: '/tmp/root' }));
  });

  it('hasGroup and requireGroup take the store first and a group name second', () => {
    expectTypeOf(hasGroup).parameters.toEqualTypeOf<[store: HippoStore, group: StoreGroup]>();
    expectTypeOf(hasGroup).returns.toEqualTypeOf<boolean>();
    expectTypeOf(requireGroup<'lastRecall'>).returns.toEqualTypeOf<StoreGroups['lastRecall']>();
    // @ts-expect-error the group comes after the store
    typeOnly(() => hasGroup('base', store));
    // @ts-expect-error 'base' is always present, so it is not an optional group
    typeOnly(() => requireGroup(store, 'base'));
  });

  it('the optional groups are a closed set of four names', () => {
    expectTypeOf<OptionalGroup>().toEqualTypeOf<'localFiles' | 'vectorViews' | 'readiness' | 'lastRecall'>();
  });

  it('SupersedeWrite names the row being replaced and its successor', () => {
    expectTypeOf<SupersedeWrite['oldId']>().toEqualTypeOf<string>();
    expectTypeOf<SupersedeWrite['successor']>().toEqualTypeOf<MemoryEntry>();
    // @ts-expect-error a supersede needs both the old id and the successor
    typeOnly((): SupersedeWrite => ({ oldId: 'm_1' }));
    expect(sqliteStore).toBeTypeOf('function');
  });

  it('entryAfterOutcome takes the entry then a boolean and returns an entry', () => {
    expectTypeOf(entryAfterOutcome).parameters.toEqualTypeOf<[MemoryEntry, boolean]>();
    expectTypeOf(entryAfterOutcome).returns.toEqualTypeOf<MemoryEntry>();
    expectTypeOf<InstanceType<typeof RejectedValueError>>().toMatchTypeOf<Error>();
  });
});
