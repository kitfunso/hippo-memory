// The graph is derived outside the write lock and only its difference is written, so an unchanged
// object costs no write and a renamed one keeps its entity id and the edges that point at it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { saveDecision } from '../../src/objects/decisions.js';
import { savePolicy } from '../../src/objects/policies.js';
import { saveCustomerNote } from '../../src/objects/customer-notes.js';
import { saveProjectBrief } from '../../src/objects/project-briefs.js';
import { extractGraph, deriveGraph, loadGraphSources, MAX_REFERENCES_PER_OBJECT } from '../../src/graph/extract.js';
import { readGraphDelta, entityKey, type GraphOp } from '../../src/graph/delta.js';
import { insertEntityAt } from '../_helpers/graph-seed.js';
import type { EntityType, SourceObjectType } from '../../src/store/graph-rows.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/core/config.js';
import { deleteEntry } from '../_helpers/root-forms.js';

const T = 'default';

function onStore<R>(home: string, read: (db: DatabaseSyncLike) => R): R {
  const db = openHippoDb(home);
  try {
    return read(db);
  } finally {
    closeHippoDb(db);
  }
}

async function deltaOf(home: string, tenant: string = T): Promise<GraphOp[]> {
  const derived = deriveGraph(await loadGraphSources(objectsAt(home), tenant));
  return readGraphDelta(sqliteStore(home).graphReads, tenant, derived);
}

const opNames = (ops: GraphOp[]): string[] => ops.map((o) => o.op);

interface StoredEntity { id: number; entity_type: string; name: string; memory_id: string | null; source_object_type: string | null; source_object_id: number | null }
interface StoredRelation { from_entity_id: number; to_entity_id: number; rel_type: string; memory_id: string | null; source_object_type: string | null; source_object_id: number | null }

/** The tenant's stored graph by natural key, leaving out ids and timestamps. */
function storedByKey(home: string, tenant: string) {
  return onStore(home, (db) => {
    // SAFETY: the SELECT names the columns StoredEntity declares.
    const ents = db.prepare(`SELECT id, entity_type, name, memory_id, source_object_type, source_object_id FROM entities WHERE tenant_id = ?`).all(tenant) as StoredEntity[];
    // SAFETY: the SELECT names the columns StoredRelation declares.
    const rels =db.prepare(`SELECT from_entity_id, to_entity_id, rel_type, memory_id, source_object_type, source_object_id FROM relations WHERE tenant_id = ?`).all(tenant) as StoredRelation[];
    // SAFETY: the v38 CHECK constraints hold entity_type and source_object_type to these enums.
    const keyOf = (e: StoredEntity) => entityKey({ entityType: e.entity_type as EntityType, sourceObject: { type: e.source_object_type as SourceObjectType, id: Number(e.source_object_id) } });
    const keyById = new Map(ents.map((e) => [e.id, keyOf(e)]));
    return {
      entities: ents.map((e) => `${keyOf(e)} ${e.name} ${e.memory_id}`).sort(),
      relations: rels.map((r) => `${keyById.get(r.from_entity_id)}>${keyById.get(r.to_entity_id)} ${r.rel_type} ${r.memory_id} ${r.source_object_type}:${r.source_object_id}`).sort(),
    };
  });
}

async function derivedByKey(home: string, tenant: string) {
  const g = deriveGraph(await loadGraphSources(objectsAt(home), tenant));
  return {
    entities: g.entities.map((e) => `${entityKey(e)} ${e.name} ${e.memoryId}`).sort(),
    relations: g.relations.map((r) => `${entityKey(r.from)}>${entityKey(r.to)} ${r.relType} ${r.memoryId} ${r.sourceObject.type}:${r.sourceObject.id}`).sort(),
  };
}

function entityIdOf(home: string, type: SourceObjectType, objectId: number): number {
  return onStore(home, (db) => {
    // SAFETY: the SELECT names one id column.
    const row = db.prepare(`SELECT id FROM entities WHERE source_object_type = ? AND source_object_id = ? ORDER BY id LIMIT 1`).get(type, objectId) as { id: number } | undefined;
    if (!row) throw new Error(`no entity for ${type} ${objectId}`);
    return row.id;
  });
}

/** The object fixtures of tests/graph/graph-cross-object.test.ts, one per case. */
const CROSS_OBJECT_FIXTURES: Array<[string, (h: string) => Promise<void>]> = [
  ['a decision names a policy', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'RetryPolicy', policyText: 'retry up to 3x' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'We adopt RetryPolicy for all services' });
  }],
  ['an object names itself', async (h) => { await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'SelfRef', policyText: 'SelfRef governs SelfRef itself' }); }],
  ['a name inside a longer word', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'Cache', policyText: 'caching config' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'the system cached results last week' });
  }],
  ['a name below the length floor', async (h) => {
    await saveCustomerNote(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { customer: 'Abc', note: 'short name customer' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'we onboarded Abc this quarter' });
  }],
  ['a name above the length cap', async (h) => {
    const text = 'Adopt the new microservices event-driven architecture with sagas and CQRS for the order domain';
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: text });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: `${text} - refined further` });
  }],
  ['a name two entities share', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'Shared', policyText: 'a policy' });
    await saveCustomerNote(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { customer: 'Shared', note: 'a customer' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'this references Shared somehow' });
  }],
  ['more targets than the per-source cap', async (h) => {
    const names = Array.from({ length: MAX_REFERENCES_PER_OBJECT + 5 }, (_, i) => `PolicyNum${String(i).padStart(3, '0')}`);
    for (const n of names) await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: n, policyText: 'x' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: `a decision that mentions ${names.join(' and ')}` });
  }],
  ['one reference, extracted twice', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'CacheTtl', policyText: 'ttl 60s' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'tune CacheTtl down' });
  }],
  ['a source whose mirror was forgotten', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'AlphaPolicy', policyText: 'p' });
    deleteEntry(h, (await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'uses AlphaPolicy heavily' })).memoryId!);
  }],
  ['a supersedes pair', async (h) => {
    const d1 = await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'Adopt Postgres' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'Adopt Postgres (managed)', supersedesDecisionId: d1.id });
  }],
  ['a project brief source', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'GreenPolicy', policyText: 'carbon-aware scheduling' });
    await saveProjectBrief(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { repo: 'myrepo', summary: 'this service enforces GreenPolicy across jobs' });
  }],
  ['a superseded target', async (h) => {
    const p1 = await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'OldPol', policyText: 'v1' });
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'NewPol', policyText: 'v2', supersedesPolicyId: p1.id });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'we still cite OldPol but adopt NewPol' });
  }],
  ['a superseded source', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'LivePolicy', policyText: 'p' });
    const d1 = await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'd1 leans on LivePolicy' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'd2 supersedes the prior call', supersedesDecisionId: d1.id });
  }],
  ['a name that prefixes a longer one', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'postgres', policyText: 'a' });
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'postgres pro', policyText: 'b' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'migrate to postgres pro this quarter' });
  }],
  ['a source naming two targets', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'PolicyAlpha', policyText: 'a' });
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { policyName: 'PolicyBeta', policyText: 'b' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, T, { decisionText: 'balance PolicyAlpha against PolicyBeta carefully' });
  }],
  ['a name in another tenant', async (h) => {
    await savePolicy(objectsAt(h), loadConfig(h).defaultHalfLifeDays, 'tenantA', { policyName: 'TenantAPolicy', policyText: 'p' });
    await saveDecision(objectsAt(h), loadConfig(h).defaultHalfLifeDays, 'tenantB', { decisionText: 'mentions TenantAPolicy from another tenant' });
  }],
];

describe('graph delta', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('graph-delta'); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it.each(CROSS_OBJECT_FIXTURES)('deriveGraph gives, by natural key, the rows the rebuild writes: %s', async (_, setup) => {
    await setup(home);
    for (const tenant of [T, 'tenantA', 'tenantB']) {
      await extractGraph(sqliteStore(home), tenant);
      expect(await derivedByKey(home, tenant)).toEqual(storedByKey(home, tenant));
    }
  });

  it('the delta of a graph against itself is empty', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    const d1 = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'We adopt RetryPolicy for billing' });
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'We adopt RetryPolicy everywhere', supersedesDecisionId: d1.id });
    deleteEntry(home, (await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'RetryPolicy also covers search' })).memoryId!);
    await extractGraph(sqliteStore(home), T);

    expect(await deltaOf(home)).toEqual([]);
  });

  it('a renamed decision gives one entity update and no relation operations', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'We adopt RetryPolicy for billing' });
    await extractGraph(sqliteStore(home), T);
    onStore(home, (db) => db.prepare(`UPDATE decisions SET decision_text = ? WHERE id = ?`).run('We adopt RetryPolicy for all billing jobs', d.id));

    const ops = await deltaOf(home);

    expect(opNames(ops)).toEqual(['updateEntity']);
    expect(ops[0]).toMatchObject({ id: entityIdOf(home, 'decision', d.id), entity: { name: 'We adopt RetryPolicy for all billing jobs' } });
  });

  it('a closed decision gives one entity delete and no inserts', async () => {
    await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'Keep this one' });
    const gone = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'Close this one' });
    await extractGraph(sqliteStore(home), T);
    // Flipped in SQL: closeDecision also drops the graph row itself, which would leave nothing to diff.
    onStore(home, (db) => db.prepare(`UPDATE decisions SET status = 'closed' WHERE id = ?`).run(gone.id));

    expect(await deltaOf(home)).toEqual([{ op: 'deleteEntity', id: entityIdOf(home, 'decision', gone.id) }]);
  });

  it('a duplicate current entity gives one delete', async () => {
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'Adopt Postgres' });
    await extractGraph(sqliteStore(home), T);
    const dup = insertEntityAt(home, T, { entityType: 'decision', name: 'Adopt Postgres', memoryId: d.memoryId, sourceObject: { type: 'decision', id: d.id } });

    expect(await deltaOf(home)).toEqual([{ op: 'deleteEntity', id: dup.id }]);
  });

  it('an entity with no source object gives one delete', async () => {
    const d = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, { decisionText: 'Adopt Postgres' });
    await extractGraph(sqliteStore(home), T);
    const loose = insertEntityAt(home, T, { entityType: 'system', name: 'Postgres', memoryId: d.memoryId });

    expect(await deltaOf(home)).toEqual([{ op: 'deleteEntity', id: loose.id }]);
  });
});
