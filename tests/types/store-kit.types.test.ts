/** The types an integrator sees from `hippo-memory/store-kit` (src/entry/store-kit.ts), the contract for a second store. */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  RejectedValueError,
  entryAfterOutcome,
  sqliteStore,
  type CoreGroups,
  type HippoStore,
  type MemoryEntry,
  type SupersedeWrite,
} from '../../src/entry/store-kit.js';
import type { DecayOptions } from '../../src/entry/memory.js';
import type { StoreRules } from '../../src/base/ports/infra.js';
type LossAversion = Pick<DecayOptions, 'lossAversionRatio'>;

describe('hippo-memory/store-kit entry types', () => {
  it('sqliteStore takes a root path and the ratio its root read, and returns the core store', () => {
    expectTypeOf(sqliteStore).parameters.toEqualTypeOf<[hippoRoot: string, rules?: StoreRules]>();
    expectTypeOf(sqliteStore).returns.toEqualTypeOf<HippoStore>();
    // @ts-expect-error the root is a path string
    typeOnly(() => sqliteStore({ hippoRoot: '/tmp/root' }));
  });

  it('a store implements the six core groups whole, and HippoStore names no local tier', () => {
    expectTypeOf<keyof CoreGroups>().toEqualTypeOf<
      'keyWrites' | 'entryWrites' | 'contextReads' | 'auditLog' | 'vectors' | 'vectorWrites'
    >();
    expectTypeOf<HippoStore>().toMatchTypeOf<CoreGroups>();
    expectTypeOf<Extract<keyof HippoStore, 'hippoDb'>>().toEqualTypeOf<never>();
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
