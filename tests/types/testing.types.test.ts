/** The types an integrator sees from `hippo-memory/testing` (src/entry/testing.ts): the eval kit, with no reset seams. */

import { describe, it, expect, expectTypeOf } from 'vitest';
import * as testing from '../../src/entry/testing.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import type { TenantId } from '../../src/base/util/tenant.js';

describe('hippo-memory/testing entry types', () => {
  it('the eval kit takes a store folder', () => {
    expectTypeOf(testing.initStore).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(testing.loadAllEntries).toEqualTypeOf<(hippoRoot: string) => MemoryEntry[]>();
    expectTypeOf(testing.loadEmbeddingIndex).toEqualTypeOf<(hippoRoot: string) => Record<string, number[]>>();
    expectTypeOf(testing.writeEntry).parameters.toEqualTypeOf<
      [hippoRoot: string, entry: MemoryEntry, opts?: testing.WriteEntryOptions]
    >();
    expectTypeOf(testing.loadRecallSearchEntries).parameters.toEqualTypeOf<
      [
        hippoRoot: string,
        query: string,
        limit: number | undefined,
        tenantId: TenantId,
        requestedScope?: string,
        explicitScopeMode?: 'exact' | 'additive',
        includeSuperseded?: boolean,
        originProjects?: string | readonly string[],
        ownScope?: string,
      ]
    >();
  });

  it('the snake_case forms take and return the wire keys', () => {
    expectTypeOf(testing.loadAllEntriesWire).toEqualTypeOf<(hippoRoot: string) => testing.MemoryWire[]>();
    expectTypeOf(testing.writeEntryWire).parameter(1).toEqualTypeOf<testing.MemoryWire>();
    expectTypeOf(testing.createMemoryWire).returns.toEqualTypeOf<testing.MemoryWire>();
  });

  it('the entry exports the eval kit, its ten snake_case forms and nine handle helpers', () => {
    expectTypeOf<keyof typeof testing>().toEqualTypeOf<
      | 'ambientSecretAdmit'
      | 'initStore'
      | 'embedMemory'
      | 'loadAllEntries'
      | 'loadEmbeddingIndex'
      | 'loadRecallSearchEntries'
      | 'writeEntry'
      | 'ambientSecretAdmitWire'
      | 'batchWriteAndDeleteWire'
      | 'calculateStrengthWire'
      | 'createMemoryWire'
      | 'embedMemoryWire'
      | 'hybridSearchWire'
      | 'isWorthSurfacingWire'
      | 'loadAllEntriesWire'
      | 'upsertEntryRowWire'
      | 'writeEntryWire'
      | 'resolveTenantId'
      | 'upsertEntryRow'
      | 'writeEntryDbOnly'
      | 'buildIndexFromDb'
      | 'writeIndexMirror'
      | 'loadVectorCandidateEntriesAt'
      | 'writeDeliveryEventOnHandle'
      | 'recordTokenUse'
      | 'tokensBySession'
    >();
    expect(Object.keys(testing)).toHaveLength(26);
  });
});
