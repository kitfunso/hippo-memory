// GraphReads answers alike on hippo.db and on a store held in memory: the same rows, the same order, the same rows hidden and the same truncated flag.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { ScopeActor } from '../../src/base/scope/recall-scope.js';
import type { GraphRows, GraphViewQuery } from '../../src/store/port.js';
import type { Entity, Relation, StoredGraph } from '../../src/store/port/graph-reads.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
  expectSameOutcomes,
} from '../_helpers/store-conformance.js';
import type { AuditEvent } from '../../src/store/port/types.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import {
  BULK_TENANT,
  HELD_SCOPE,
  MANY,
  seededAt,
  seedGraphRows,
  SOLO_TENANT,
  type SeededGraph,
} from '../_helpers/graph-reads-seed.js';

oneRequestPerTest();

type Call<R = GraphRows> = GroupCall<'graphReads', R>;
type Edge = readonly [from: number, to: number];

/** The rows by id, which is all most cases need to tell one answer from another. */
interface RowIds {
  readonly entities: readonly number[];
  readonly relations: readonly Edge[];
  readonly truncated: boolean;
}

const ADMIN: ScopeActor = { role: 'admin' };
const MEMBER: ScopeActor = { role: 'member' };
const GRANTED: ScopeActor = { role: 'member', scopes: [HELD_SCOPE] };
const ALICE: ScopeActor = { role: 'member', owner: 'alice' };
const EMPTY: RowIds = { entities: [], relations: [], truncated: false };

let fixture: TwoTenantFixture;
let g: SeededGraph;
let auditBefore: readonly AuditEvent[];
interface IdLists {
  readonly entities: number[];
  readonly relations: Edge[];
}
/** Tenant A's entities and relations, newest first. */
let newest: IdLists;
/** What a walk from Hub holds, and the relations among those five. */
let aroundHub: IdLists;

const rows =
  (query: Partial<GraphViewQuery> = {}, tenantId = TENANT_A): Call =>
  (group) =>
    group.graphRows(tenantId, { limit: 100, ...query });
const without = <T>(items: readonly T[], ...gone: readonly T[]): T[] => items.filter((item) => !gone.includes(item));
const ids = (entities: readonly number[], relations: readonly Edge[], truncated = false): RowIds => ({
  entities,
  relations,
  truncated,
});

/** Both stores' answers, asserted equal, with nothing appended to either audit log. */
async function answers<R>(calls: readonly Call<R>[]): Promise<R[]> {
  const sides = await onBothStores(fixture, 'graphReads', calls);
  expectSameOutcomes(sides);
  expect(sides.sqlite.audit).toEqual(auditBefore);
  return sides.sqlite.outcomes.map((o) => {
    if ('error' in o) throw new Error(o.error);
    return o.value;
  });
}

async function entityIds(calls: readonly Call<Entity[]>[]): Promise<number[][]> {
  return (await answers(calls)).map((read) => read.map((row) => row.id));
}

async function edges(calls: readonly Call<Relation[]>[]): Promise<Edge[][]> {
  return (await answers(calls)).map((read) => read.map((r): Edge => [r.fromEntityId, r.toEntityId]));
}

async function readIds(calls: readonly Call[]): Promise<RowIds[]> {
  return (await answers(calls)).map((read) =>
    ids(
      read.entities.map((e) => e.id),
      read.relations.map((r): Edge => [r.fromEntityId, r.toEntityId]),
      read.truncated,
    ),
  );
}

beforeAll(async () => {
  fixture = seedTwoTenants();
  g = await seedGraphRows(fixture.dir);
  const { e } = g;
  newest = {
    entities: [e.anchored, e.shared, e.lone, e.twinOpen, e.twinHeld, e.mine, e.secret, e.spoke2, e.spoke1, e.hub],
    relations: [
      [e.shared, e.hub],
      [e.secret, e.mine],
      [e.hub, e.secret],
      [e.spoke1, e.spoke2],
      [e.hub, e.spoke2],
      [e.hub, e.spoke1],
    ],
  };
  aroundHub = {
    entities: [e.hub, e.spoke1, e.spoke2, e.secret, e.shared],
    relations: without(newest.relations, newest.relations[1]!),
  };
  // Unasserted here, so a store that disagrees fails the test that reads the rows and not the whole file.
  auditBefore = (await onBothStores(fixture, 'graphReads', [])).sqlite.audit;
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

describe('GraphReads.graphRows over the whole graph', () => {
  it('reads nothing for a tenant with no graph, and every field of the rows of the tenants that hold one', async () => {
    const { e, memories } = g;
    const [nobody, solo, newestOfA] = await answers([rows({}, 'nobody'), rows({}, SOLO_TENANT), rows({ limit: 1 })]);
    expect(nobody).toEqual(EMPTY);
    expect(solo).toEqual({
      entities: [
        {
          id: e.solo,
          tenantId: SOLO_TENANT,
          entityType: 'project',
          name: 'Only',
          memoryId: 'mem_gsolo',
          sourceKind: 'distilled',
          createdAt: seededAt(1),
        },
      ],
      relations: [],
      truncated: false,
    });
    expect(newestOfA).toEqual({
      entities: [
        {
          id: e.anchored,
          tenantId: TENANT_A,
          entityType: 'policy',
          name: 'Anchored',
          memoryId: null,
          sourceKind: 'distilled',
          sourceObjectType: 'policy',
          sourceObjectId: expect.any(Number),
          createdAt: seededAt(7),
        },
      ],
      relations: [
        {
          id: expect.any(Number),
          tenantId: TENANT_A,
          fromEntityId: e.shared,
          toEntityId: e.hub,
          relType: 'references',
          memoryId: memories.team,
          sourceKind: 'distilled',
          createdAt: seededAt(12),
        },
      ],
      truncated: true,
    });
  });

  it("lists a tenant newest first, the larger id first inside a shared timestamp, and never another tenant's rows", async () => {
    const { e } = g;
    expect(await readIds([rows(), rows({}, TENANT_B), rows({ reader: MEMBER }, TENANT_B)])).toEqual([
      ids(newest.entities, newest.relations),
      ids([e.otherB, e.sharedB], [[e.sharedB, e.otherB]]),
      ids([e.otherB, e.sharedB], [[e.sharedB, e.otherB]]),
    ]);
  });

  it('keeps the newest rows at, under and over the cap, capping entities and relations each on their own', async () => {
    const { e } = g;
    const [atCap, overCap, relationsAtCap, three, one, soloAtCap, bOne, bTwo, bThree] = await readIds([
      rows({ limit: 10 }),
      rows({ limit: 11 }),
      rows({ limit: 6 }),
      rows({ limit: 3 }),
      rows({ limit: 1 }),
      rows({ limit: 1 }, SOLO_TENANT),
      rows({ limit: 1 }, TENANT_B),
      rows({ limit: 2 }, TENANT_B),
      rows({ limit: 3 }, TENANT_B),
    ]);
    expect(atCap).toEqual(ids(newest.entities, newest.relations, true));
    expect(overCap).toEqual(ids(newest.entities, newest.relations, false));
    expect(relationsAtCap).toEqual(ids(newest.entities.slice(0, 6), newest.relations, true));
    expect(three).toEqual(ids(newest.entities.slice(0, 3), newest.relations.slice(0, 3), true));
    expect(one).toEqual(ids([e.anchored], [[e.shared, e.hub]], true));
    expect(soloAtCap).toEqual(ids([e.solo], [], true));
    expect([bOne, bTwo, bThree]).toEqual([
      ids([e.otherB], [[e.sharedB, e.otherB]], true),
      ids([e.otherB, e.sharedB], [[e.sharedB, e.otherB]], true),
      ids([e.otherB, e.sharedB], [[e.sharedB, e.otherB]], false),
    ]);
  });

  it('hides a row whose memory the reader may not read, keeps a relation whose end is hidden, and judges truncated before hiding', async () => {
    const { e } = g;
    const heldEdge = newest.relations[1]!;
    const [member, admin, granted, alice, memberAtCap, memberTwo] = await readIds([
      rows({ reader: MEMBER }),
      rows({ reader: ADMIN }),
      rows({ reader: GRANTED }),
      rows({ reader: ALICE }),
      rows({ reader: MEMBER, limit: 10 }),
      rows({ reader: MEMBER, limit: 2 }),
    ]);
    const memberSees = ids(without(newest.entities, e.twinHeld, e.mine, e.secret), without(newest.relations, heldEdge));
    expect(member).toEqual(memberSees);
    expect(admin).toEqual(ids(without(newest.entities, e.mine), newest.relations));
    expect(granted).toEqual(admin);
    expect(alice).toEqual(ids(without(newest.entities, e.twinHeld, e.secret), without(newest.relations, heldEdge)));
    expect(memberAtCap).toEqual({ ...memberSees, truncated: true });
    // The hidden relation is not replaced by the next newest one.
    expect(memberTwo).toEqual(ids([e.anchored, e.shared], [[e.shared, e.hub]], true));
  });
});

describe('GraphReads.graphRows from a name', () => {
  it('answers empty and not truncated for a name nobody holds, one in another case, one only another tenant holds and any name in an empty tenant', async () => {
    const empty = await readIds([
      rows({ entity: 'Nope' }),
      rows({ entity: 'hub' }),
      rows({ entity: 'Other' }),
      rows({ entity: 'Other', limit: 1 }),
      rows({ entity: 'Hub' }, TENANT_B),
      rows({ entity: 'Hub' }, 'nobody'),
    ]);
    expect(empty).toEqual([EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
  });

  it('walks one hop from the named entity, lists what it holds by id and returns the relations among them newest first', async () => {
    const { e } = g;
    expect(
      await readIds([rows({ entity: 'Hub' }), rows({ entity: 'Lone' }), rows({ entity: 'Only' }, SOLO_TENANT)]),
    ).toEqual([ids(aroundHub.entities, aroundHub.relations), ids([e.lone], []), ids([e.solo], [])]);
  });

  it('starts from every entity of the name, lowest id first, inside the asking tenant', async () => {
    const { e } = g;
    const [spokes, firstSpoke, sharedA, sharedB] = await readIds([
      rows({ entity: 'Spoke' }),
      rows({ entity: 'Spoke', limit: 1 }),
      rows({ entity: 'Shared' }),
      rows({ entity: 'Shared' }, TENANT_B),
    ]);
    expect(spokes).toEqual(
      ids(
        [e.hub, e.spoke1, e.spoke2],
        [
          [e.spoke1, e.spoke2],
          [e.hub, e.spoke2],
          [e.hub, e.spoke1],
        ],
      ),
    );
    expect(firstSpoke).toEqual(ids([e.spoke1], [], true));
    expect(sharedA).toEqual(ids([e.hub, e.shared], [[e.shared, e.hub]]));
    expect(sharedB).toEqual(ids([e.sharedB, e.otherB], [[e.sharedB, e.otherB]]));
  });

  it('stops joining once it holds limit ids, taking the newest relations first, and says truncated at every cap it meets', async () => {
    const { e } = g;
    const byLimit = await readIds([1, 2, 3, 4, 5, 6, 7].map((limit) => rows({ entity: 'Hub', limit })));
    const [sharedHub, hubSecret, , hubSpoke2] = aroundHub.relations;
    expect(byLimit).toEqual([
      ids([e.hub], [], true),
      ids([e.hub, e.shared], [sharedHub!], true),
      ids([e.hub, e.secret, e.shared], [sharedHub!, hubSecret!], true),
      ids([e.hub, e.spoke2, e.secret, e.shared], [sharedHub!, hubSecret!, hubSpoke2!], true),
      // Every neighbor fits, and the relations among them come back exactly limit long.
      ids(aroundHub.entities, aroundHub.relations, true),
      ids(aroundHub.entities, aroundHub.relations, false),
      ids(aroundHub.entities, aroundHub.relations, false),
    ]);
  });

  it('answers empty and not truncated when no start entity shows, though a relation the reader may read touches it', async () => {
    const { e } = g;
    const [secret, secretAtCap, mine, aliceSecret, adminMine, twinFirst, twinBoth, twinUnder, twinUnread] =
      await readIds([
        rows({ entity: 'Secret', reader: MEMBER }),
        rows({ entity: 'Secret', reader: MEMBER, limit: 1 }),
        rows({ entity: 'Mine', reader: MEMBER }),
        rows({ entity: 'Secret', reader: ALICE }),
        rows({ entity: 'Mine', reader: ADMIN }),
        rows({ entity: 'Twin', reader: MEMBER, limit: 1 }),
        rows({ entity: 'Twin', reader: MEMBER, limit: 2 }),
        rows({ entity: 'Twin', reader: MEMBER, limit: 3 }),
        rows({ entity: 'Twin' }),
      ]);
    expect([secret, secretAtCap, mine, aliceSecret, adminMine]).toEqual([EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
    // The cap picks the start entities before any is hidden: the one Twin a member may read sits past a cap of one.
    expect(twinFirst).toEqual(EMPTY);
    expect(twinBoth).toEqual(ids([e.twinOpen], [], true));
    expect(twinUnder).toEqual(ids([e.twinOpen], []));
    expect(twinUnread).toEqual(ids([e.twinHeld, e.twinOpen], []));
  });

  it('hides the rows a walk reached that the reader may not read, keeps a relation to a hidden end, and judges truncated before hiding', async () => {
    const { e } = g;
    const [memberHub, memberHubAtCap, unreadSecret, grantedSecret, adminSecret, aliceMine] = await readIds([
      rows({ entity: 'Hub', reader: MEMBER }),
      rows({ entity: 'Hub', reader: MEMBER, limit: 5 }),
      rows({ entity: 'Secret' }),
      rows({ entity: 'Secret', reader: GRANTED }),
      rows({ entity: 'Secret', reader: ADMIN }),
      rows({ entity: 'Mine', reader: ALICE }),
    ]);
    const secretEdges: Edge[] = [
      [e.secret, e.mine],
      [e.hub, e.secret],
    ];
    expect(memberHub).toEqual(ids(without(aroundHub.entities, e.secret), aroundHub.relations));
    expect(memberHubAtCap).toEqual({ ...memberHub, truncated: true });
    expect(unreadSecret).toEqual(ids([e.hub, e.secret, e.mine], secretEdges));
    expect(grantedSecret).toEqual(ids([e.hub, e.secret], secretEdges));
    expect(adminSecret).toEqual(grantedSecret);
    expect(aliceMine).toEqual(ids([e.mine], []));
  });

  it('joins relations per 400 start entities in order, and lists each 400 ids it holds by id', async () => {
    const { e, many } = g;
    const first = many[0]!;
    const last = many[MANY - 1]!;
    const [oneTail, bothTails, startsOnly, firstBatch, newestOfBulk] = await readIds([
      rows({ entity: 'Many', limit: MANY + 1 }, BULK_TENANT),
      rows({ entity: 'Many', limit: MANY + 2 }, BULK_TENANT),
      rows({ entity: 'Many', limit: MANY }, BULK_TENANT),
      rows({ entity: 'Many', limit: 400 }, BULK_TENANT),
      rows({ limit: 3 }, BULK_TENANT),
    ]);
    // The older relation joins first because its start entity sits in the first 400, so the one id left goes to TailA.
    expect(oneTail).toEqual(ids([...many.slice(0, 400), e.tailA, ...many.slice(400)], [[first, e.tailA]], true));
    expect(bothTails).toEqual(
      ids(
        [...many.slice(0, 400), e.tailA, e.tailB, ...many.slice(400)],
        [
          [last, e.tailB],
          [first, e.tailA],
        ],
      ),
    );
    expect(startsOnly).toEqual(ids(many, [], true));
    expect(firstBatch).toEqual(ids(many.slice(0, 400), [], true));
    expect(newestOfBulk).toEqual(
      ids(
        [last, many[MANY - 2]!, many[MANY - 3]!],
        [
          [last, e.tailB],
          [first, e.tailA],
        ],
        true,
      ),
    );
  });
});

describe('GraphReads walk reads', () => {
  it('maps memory ids to their entities, by id in each 400, inside the asking tenant', async () => {
    const { e, memories, many } = g;
    const [both, team, otherTenant, none, bulk] = await entityIds([
      (r) => r.entitiesForMemories(TENANT_A, [memories.held, memories.team]),
      (r) => r.entitiesForMemories(TENANT_A, [memories.team]),
      (r) => r.entitiesForMemories(TENANT_B, [memories.team]),
      (r) => r.entitiesForMemories(TENANT_A, []),
      (r) => r.entitiesForMemories(BULK_TENANT, ['mem_gbulk']),
    ]);
    expect(both).toEqual([e.hub, e.spoke1, e.spoke2, e.secret, e.twinHeld, e.twinOpen, e.lone, e.shared]);
    expect(team).toEqual([e.hub, e.spoke1, e.spoke2, e.twinOpen, e.lone, e.shared]);
    expect([otherTenant, none]).toEqual([[], []]);
    expect(bulk).toEqual([e.tailA, e.tailB, ...many]);
  });

  it('reads entities by id, in id order inside each 400 asked, and never from another tenant', async () => {
    const { e, many } = g;
    const [scrambled, crossTenant, reversed, none] = await entityIds([
      (r) => r.entitiesByIds(TENANT_A, [e.shared, e.hub, e.secret]),
      (r) => r.entitiesByIds(TENANT_A, [e.sharedB, e.hub]),
      (r) => r.entitiesByIds(BULK_TENANT, [...many].reverse()),
      (r) => r.entitiesByIds(TENANT_A, []),
    ]);
    expect(scrambled).toEqual([e.hub, e.secret, e.shared]);
    expect(crossTenant).toEqual([e.hub]);
    // The first 400 asked are the last 400 made, so they come back before the five oldest.
    expect(reversed).toEqual([...many.slice(MANY - 400), ...many.slice(0, MANY - 400)]);
    expect(none).toEqual([]);
  });

  it('reads the newest limit relations touching each 400 ids, keeping a repeat in its first place', async () => {
    const { e, many } = g;
    const first = many[0]!;
    const last = many[MANY - 1]!;
    const [hub, hubTwo, hubSecret, perBatch, repeated, otherTenant, zero, none] = await edges([
      (r) => r.neighborRelations(TENANT_A, [e.hub], { limit: 100 }),
      (r) => r.neighborRelations(TENANT_A, [e.hub], { limit: 2 }),
      (r) => r.neighborRelations(TENANT_A, [e.hub, e.secret], { limit: 100 }),
      (r) => r.neighborRelations(BULK_TENANT, many, { limit: 1 }),
      (r) => r.neighborRelations(BULK_TENANT, [...many.slice(0, 400), e.tailA], { limit: 5 }),
      (r) => r.neighborRelations(TENANT_B, [e.hub], { limit: 100 }),
      (r) => r.neighborRelations(TENANT_A, [e.hub], { limit: 0 }),
      (r) => r.neighborRelations(TENANT_A, [], { limit: 100 }),
    ]);
    const hubEdges: Edge[] = [
      [e.shared, e.hub],
      [e.hub, e.secret],
      [e.hub, e.spoke2],
      [e.hub, e.spoke1],
    ];
    expect(hub).toEqual(hubEdges);
    expect(hubTwo).toEqual(hubEdges.slice(0, 2));
    expect(hubSecret).toEqual([
      [e.shared, e.hub],
      [e.secret, e.mine],
      [e.hub, e.secret],
      [e.hub, e.spoke2],
      [e.hub, e.spoke1],
    ]);
    // The limit holds per 400: the newer TailB relation still comes back, after the first batch's.
    expect(perBatch).toEqual([
      [first, e.tailA],
      [last, e.tailB],
    ]);
    expect(repeated).toEqual([[first, e.tailA]]);
    expect([otherTenant, zero, none]).toEqual([[], [], []]);
  });
});

describe('GraphReads.storedGraph', () => {
  it("reads the tenant's rows in id order and the kind of each memory asked, whichever tenant holds it", async () => {
    const { e, memories } = g;
    const [inA, inB, unknown] = await answers<StoredGraph>([
      (r) => r.storedGraph(TENANT_A, [memories.team, 'mem_gb', 'mem_never_written']),
      (r) => r.storedGraph(TENANT_B, []),
      (r) => r.storedGraph('nobody', [memories.held]),
    ]);
    expect(inA.entities.map((row) => row.id)).toEqual([
      e.hub,
      e.spoke1,
      e.spoke2,
      e.secret,
      e.mine,
      e.twinHeld,
      e.twinOpen,
      e.lone,
      e.shared,
      e.anchored,
    ]);
    expect(inA.relations.map((row): Edge => [row.from_entity_id, row.to_entity_id])).toEqual(
      [...newest.relations].reverse(),
    );
    expect(inA.kinds).toEqual(
      new Map([
        [memories.team, 'distilled'],
        ['mem_gb', 'distilled'],
      ]),
    );
    expect(inB.entities.map((row) => row.id)).toEqual([e.sharedB, e.otherB]);
    expect(inB.kinds).toEqual(new Map());
    expect(unknown).toEqual({ kinds: new Map([[memories.held, 'distilled']]), entities: [], relations: [] });
  });
});
