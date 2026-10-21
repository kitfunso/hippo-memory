// The graph fixture: entities and relations in four tenants under three scopes, a policy-anchored entity and a
// batch-crossing run of same-named entities, written straight to hippo.db.
import { vi } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { savePolicy } from '../../src/domain/objects/policies.js';
import type { EntityType } from '../../src/store/port/graph.js';
import { insertEntityRow, insertRelationRow } from '../../src/store/sqlite/graph-writes.js';
import { TENANT_A, TENANT_B } from './store-conformance.js';
import { objectsAt } from './objects-at.js';
import { loadConfig } from '../../src/base/config/config.js';
import { writeEntry } from './root-forms.js';

const TEAM_SCOPE = null;
export const HELD_SCOPE = 'slack:private:Csecret';
export const ALICE_SCOPE = 'personal:private:alice';
export const SOLO_TENANT = 'solo';
export const BULK_TENANT = 'bulk';
/** One over a batch of 400 plus a few, so a walk from the name crosses a batch boundary. */
export const MANY = 405;
export const seededAt = (second: number): string => `2020-03-01T00:00:${String(second).padStart(2, '0')}.000Z`;

type InTenantA =
  | 'hub'
  | 'spoke1'
  | 'spoke2'
  | 'secret'
  | 'mine'
  | 'twinHeld'
  | 'twinOpen'
  | 'lone'
  | 'shared'
  | 'anchored';
type Elsewhere = 'sharedB' | 'otherB' | 'solo' | 'tailA' | 'tailB';

/** Entity ids by a short name; `many` is the bulk tenant's same-named entities in id order. */
export interface SeededGraph {
  readonly e: Readonly<Record<InTenantA | Elsewhere, number>>;
  readonly many: readonly number[];
  /** Memory ids by the scope each sits under in tenant A. */
  readonly memories: Readonly<Record<'team' | 'held' | 'alice', string>>;
}

type Db = DatabaseSyncLike;

function seeder(db: Db, dir: string) {
  const memory = (tenantId: string, id: string, scope: string | null): string => {
    writeEntry(dir, {
      ...createMemory(`source of ${id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId, scope }),
      id,
    });
    return id;
  };
  const entity = (tenantId: string, second: number, name: string, entityType: EntityType, memoryId: string): number => {
    vi.setSystemTime(new Date(seededAt(second)));
    return insertEntityRow(db, tenantId, { entityType, name, memoryId }).id;
  };
  const relation = (
    tenantId: string,
    second: number,
    fromEntityId: number,
    toEntityId: number,
    memoryId: string,
  ): number => {
    vi.setSystemTime(new Date(seededAt(second)));
    return insertRelationRow(db, tenantId, { fromEntityId, toEntityId, relType: 'references', memoryId }).id;
  };
  return { memory, entity, relation };
}

interface SeededTenantA {
  readonly memories: SeededGraph['memories'];
  readonly e: Record<InTenantA, number>;
}

function seedTenantA(db: Db, dir: string, policyId: number): SeededTenantA {
  const { memory, entity, relation } = seeder(db, dir);
  const memories = {
    team: memory(TENANT_A, 'mem_gteam', TEAM_SCOPE),
    held: memory(TENANT_A, 'mem_gheld', HELD_SCOPE),
    alice: memory(TENANT_A, 'mem_galice', ALICE_SCOPE),
  };
  const hub = entity(TENANT_A, 1, 'Hub', 'project', memories.team);
  const spoke1 = entity(TENANT_A, 2, 'Spoke', 'system', memories.team);
  const spoke2 = entity(TENANT_A, 2, 'Spoke', 'project', memories.team);
  const secret = entity(TENANT_A, 3, 'Secret', 'customer', memories.held);
  const mine = entity(TENANT_A, 4, 'Mine', 'person', memories.alice);
  const twinHeld = entity(TENANT_A, 5, 'Twin', 'person', memories.held);
  const twinOpen = entity(TENANT_A, 5, 'Twin', 'person', memories.team);
  const lone = entity(TENANT_A, 6, 'Lone', 'decision', memories.team);
  const shared = entity(TENANT_A, 7, 'Shared', 'project', memories.team);
  // Stamped with the second `shared` left on the clock, so the two newest entities share a timestamp.
  const anchored = insertEntityRow(db, TENANT_A, {
    entityType: 'policy',
    name: 'Anchored',
    memoryId: null,
    sourceObject: { type: 'policy', id: policyId },
  }).id;
  relation(TENANT_A, 8, hub, spoke1, memories.team);
  relation(TENANT_A, 8, hub, spoke2, memories.team);
  relation(TENANT_A, 9, spoke1, spoke2, memories.team);
  relation(TENANT_A, 10, hub, secret, memories.team);
  relation(TENANT_A, 11, secret, mine, memories.held);
  relation(TENANT_A, 12, shared, hub, memories.team);
  return { memories, e: { hub, spoke1, spoke2, secret, mine, twinHeld, twinOpen, lone, shared, anchored } };
}

/** Adds a graph to each of four tenants: A with rows under three scopes, B sharing one name with A, one entity under `solo`, and 405 same-named entities under `bulk`. */
export async function seedGraphRows(dir: string): Promise<SeededGraph> {
  const policyId = (
    await savePolicy(objectsAt(dir), loadConfig(dir).defaultHalfLifeDays, TENANT_A, {
      policyName: 'Anchored',
      policyText: 'kept by its object',
    })
  ).id;
  const db = openHippoDb(dir);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const a = seedTenantA(db, dir, policyId);
    const { memory, entity, relation } = seeder(db, dir);
    const memB = memory(TENANT_B, 'mem_gb', TEAM_SCOPE);
    const sharedB = entity(TENANT_B, 1, 'Shared', 'project', memB);
    const otherB = entity(TENANT_B, 2, 'Other', 'system', memB);
    relation(TENANT_B, 3, sharedB, otherB, memB);
    const solo = entity(SOLO_TENANT, 1, 'Only', 'project', memory(SOLO_TENANT, 'mem_gsolo', TEAM_SCOPE));
    const memBulk = memory(BULK_TENANT, 'mem_gbulk', TEAM_SCOPE);
    const tailA = entity(BULK_TENANT, 1, 'TailA', 'system', memBulk);
    const tailB = entity(BULK_TENANT, 1, 'TailB', 'system', memBulk);
    const many = Array.from({ length: MANY }, () => entity(BULK_TENANT, 2, 'Many', 'project', memBulk));
    // The older relation hangs off the first batch of 400 and the newer off the second.
    relation(BULK_TENANT, 3, many[0]!, tailA, memBulk);
    relation(BULK_TENANT, 4, many[MANY - 1]!, tailB, memBulk);
    return { memories: a.memories, e: { ...a.e, sharedB, otherB, solo, tailA, tailB }, many };
  } finally {
    vi.useRealTimers();
    closeHippoDb(db);
  }
}
