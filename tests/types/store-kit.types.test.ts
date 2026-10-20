/** The types an integrator sees from `hippo-memory/store-kit` (src/entry/store-kit.ts), the contract for a second store. */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  RejectedValueError,
  entryAfterOutcome,
  hasGroup,
  requireGroup,
  sqliteStore,
  type HippoStore,
  type MemoryEntry,
  type OptionalGroup,
  type StoreGroup,
  type StoreGroups,
  type SupersedeWrite,
} from '../../src/entry/store-kit.js';
import type { LossAversion } from '../../src/core/memory.js';
import type { LocalStore } from '../../src/store/local/index.js';

declare const store: HippoStore;

describe('hippo-memory/store-kit entry types', () => {
  it('sqliteStore takes a root path and the ratio its root read, and returns a store with every group and local files', () => {
    expectTypeOf(sqliteStore).parameters.toEqualTypeOf<[hippoRoot: string, rules?: LossAversion]>();
    expectTypeOf(sqliteStore).returns.toEqualTypeOf<LocalStore & StoreGroups>();
    // @ts-expect-error the root is a path string
    typeOnly(() => sqliteStore({ hippoRoot: '/tmp/root' }));
  });

  it('hasGroup narrows an optional group; hasGroup and requireGroup take the store first and a group name second', () => {
    typeOnly(() => {
      if (hasGroup(store, 'lastRecall')) expectTypeOf(store.lastRecall).toEqualTypeOf<StoreGroups['lastRecall']>();
      expectTypeOf(hasGroup(store, 'base')).toEqualTypeOf<boolean>();
      expectTypeOf(hasGroup(store, 'sessions' satisfies StoreGroup)).toEqualTypeOf<boolean>();
    });
    expectTypeOf(requireGroup<'lastRecall'>).returns.toEqualTypeOf<StoreGroups['lastRecall']>();
    // @ts-expect-error the group comes after the store
    typeOnly(() => hasGroup('base', store));
    // @ts-expect-error 'base' is always present, so it is not an optional group
    typeOnly(() => requireGroup(store, 'base'));
  });

  it('the optional groups are a closed set of three names, and local files are not on the port', () => {
    expectTypeOf<OptionalGroup>().toEqualTypeOf<'vectorViews' | 'readiness' | 'lastRecall'>();
    expectTypeOf<'localFiles' extends StoreGroup ? true : false>().toEqualTypeOf<false>();
    // @ts-expect-error a store's local files sit beside the port, not in a group
    typeOnly(() => hasGroup(store, 'localFiles'));
  });

  it('SupersedeWrite names the row being replaced and its successor', () => {
    expectTypeOf<SupersedeWrite['oldId']>().toEqualTypeOf<string>();
    expectTypeOf<SupersedeWrite['successor']>().toEqualTypeOf<MemoryEntry>();
    // @ts-expect-error a supersede needs both the old id and the successor
    typeOnly((): SupersedeWrite => ({ oldId: 'm_1' }));
    expect(sqliteStore).toBeTypeOf('function');
  });

  it('entryAfterOutcome takes the entry, a boolean and the root ratio, and returns an entry', () => {
    expectTypeOf(entryAfterOutcome).parameters.toEqualTypeOf<[MemoryEntry, boolean, LossAversion?]>();
    expectTypeOf(entryAfterOutcome).returns.toEqualTypeOf<MemoryEntry>();
    expectTypeOf<InstanceType<typeof RejectedValueError>>().toMatchTypeOf<Error>();
  });
});
