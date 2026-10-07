// The graph is derived outside the write lock and only its difference is written, so an unchanged
// object costs no write and a renamed one keeps its entity id and the edges that point at it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { saveDecision } from '../src/decisions.js';
import { savePolicy } from '../src/policies.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { saveProjectBrief } from '../src/project-briefs.js';
import { extractGraph, deriveGraph, loadGraphSources, MAX_REFERENCES_PER_OBJECT } from '../src/graph-extract.js';
import { graphDelta, entityKey, type GraphOp } from '../src/graph/delta.js';
import { insertEntity } from '../src/graph/write.js';
import type { EntityType, SourceObjectType } from '../src/graph/types.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { makeRoot } from './_helpers/make-root.js';

const T = 'default';

function onStore<R>(home: string, read: (db: DatabaseSyncLike) => R): R {
  const db = openHippoDb(home);
  try {
    return read(db);
  } finally {
    closeHippoDb(db);
  }
}

function deltaOf(home: string, tenant: string = T): GraphOp[] {
  const derived = deriveGraph(loadGraphSources(home, tenant));
  return onStore(home, (db) => graphDelta(db, tenant, derived));
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

function derivedByKey(home: string, tenant: string) {
  const g = deriveGraph(loadGraphSources(home, tenant));
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

/** The object fixtures of tests/graph-cross-object.test.ts, one per case. */
const CROSS_OBJECT_FIXTURES: Array<[string, (h: string) => void]> = [
  ['a decision names a policy', (h) => {
    savePolicy(h, T, { policyName: 'RetryPolicy', policyText: 'retry up to 3x' });
    saveDecision(h, T, { decisionText: 'We adopt RetryPolicy for all services' });
  }],
  ['an object names itself', (h) => { savePolicy(h, T, { policyName: 'SelfRef', policyText: 'SelfRef governs SelfRef itself' }); }],
  ['a name inside a longer word', (h) => {
    savePolicy(h, T, { policyName: 'Cache', policyText: 'caching config' });
    saveDecision(h, T, { decisionText: 'the system cached results last week' });
  }],
  ['a name below the length floor', (h) => {
    saveCustomerNote(h, T, { customer: 'Abc', note: 'short name customer' });
    saveDecision(h, T, { decisionText: 'we onboarded Abc this quarter' });
  }],
  ['a name above the length cap', (h) => {
    const text = 'Adopt the new microservices event-driven architecture with sagas and CQRS for the order domain';
    saveDecision(h, T, { decisionText: text });
    saveDecision(h, T, { decisionText: `${text} - refined further` });
  }],
  ['a name two entities share', (h) => {
    savePolicy(h, T, { policyName: 'Shared', policyText: 'a policy' });
    saveCustomerNote(h, T, { customer: 'Shared', note: 'a customer' });
    saveDecision(h, T, { decisionText: 'this references Shared somehow' });
  }],
  ['more targets than the per-source cap', (h) => {
    const names = Array.from({ length: MAX_REFERENCES_PER_OBJECT + 5 }, (_, i) => `PolicyNum${String(i).padStart(3, '0')}`);
    for (const n of names) savePolicy(h, T, { policyName: n, policyText: 'x' });
    saveDecision(h, T, { decisionText: `a decision that mentions ${names.join(' and ')}` });
  }],
  ['one reference, extracted twice', (h) => {
    savePolicy(h, T, { policyName: 'CacheTtl', policyText: 'ttl 60s' });
    saveDecision(h, T, { decisionText: 'tune CacheTtl down' });
  }],
  ['a source whose mirror was forgotten', (h) => {
    savePolicy(h, T, { policyName: 'AlphaPolicy', policyText: 'p' });
    deleteEntry(h, saveDecision(h, T, { decisionText: 'uses AlphaPolicy heavily' }).memoryId!);
  }],
  ['a supersedes pair', (h) => {
    const d1 = saveDecision(h, T, { decisionText: 'Adopt Postgres' });
    saveDecision(h, T, { decisionText: 'Adopt Postgres (managed)', supersedesDecisionId: d1.id });
  }],
  ['a project brief source', (h) => {
    savePolicy(h, T, { policyName: 'GreenPolicy', policyText: 'carbon-aware scheduling' });
    saveProjectBrief(h, T, { repo: 'myrepo', summary: 'this service enforces GreenPolicy across jobs' });
  }],
  ['a superseded target', (h) => {
    const p1 = savePolicy(h, T, { policyName: 'OldPol', policyText: 'v1' });
    savePolicy(h, T, { policyName: 'NewPol', policyText: 'v2', supersedesPolicyId: p1.id });
    saveDecision(h, T, { decisionText: 'we still cite OldPol but adopt NewPol' });
  }],
  ['a superseded source', (h) => {
    savePolicy(h, T, { policyName: 'LivePolicy', policyText: 'p' });
    const d1 = saveDecision(h, T, { decisionText: 'd1 leans on LivePolicy' });
    saveDecision(h, T, { decisionText: 'd2 supersedes the prior call', supersedesDecisionId: d1.id });
  }],
  ['a name that prefixes a longer one', (h) => {
    savePolicy(h, T, { policyName: 'postgres', policyText: 'a' });
    savePolicy(h, T, { policyName: 'postgres pro', policyText: 'b' });
    saveDecision(h, T, { decisionText: 'migrate to postgres pro this quarter' });
  }],
  ['a source naming two targets', (h) => {
    savePolicy(h, T, { policyName: 'PolicyAlpha', policyText: 'a' });
    savePolicy(h, T, { policyName: 'PolicyBeta', policyText: 'b' });
    saveDecision(h, T, { decisionText: 'balance PolicyAlpha against PolicyBeta carefully' });
  }],
  ['a name in another tenant', (h) => {
    savePolicy(h, 'tenantA', { policyName: 'TenantAPolicy', policyText: 'p' });
    saveDecision(h, 'tenantB', { decisionText: 'mentions TenantAPolicy from another tenant' });
  }],
];

describe('graph delta', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('graph-delta'); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it.each(CROSS_OBJECT_FIXTURES)('deriveGraph gives, by natural key, the rows the rebuild writes: %s', (_, setup) => {
    setup(home);
    for (const tenant of [T, 'tenantA', 'tenantB']) {
      extractGraph(home, tenant);
      expect(derivedByKey(home, tenant)).toEqual(storedByKey(home, tenant));
    }
  });

  it('the delta of a graph against itself is empty', () => {
    savePolicy(home, T, { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    const d1 = saveDecision(home, T, { decisionText: 'We adopt RetryPolicy for billing' });
    saveDecision(home, T, { decisionText: 'We adopt RetryPolicy everywhere', supersedesDecisionId: d1.id });
    deleteEntry(home, saveDecision(home, T, { decisionText: 'RetryPolicy also covers search' }).memoryId!);
    extractGraph(home, T);

    expect(deltaOf(home)).toEqual([]);
  });

  it('a renamed decision gives one entity update and no relation operations', () => {
    savePolicy(home, T, { policyName: 'RetryPolicy', policyText: 'retry 3x' });
    const d = saveDecision(home, T, { decisionText: 'We adopt RetryPolicy for billing' });
    extractGraph(home, T);
    onStore(home, (db) => db.prepare(`UPDATE decisions SET decision_text = ? WHERE id = ?`).run('We adopt RetryPolicy for all billing jobs', d.id));

    const ops = deltaOf(home);

    expect(opNames(ops)).toEqual(['updateEntity']);
    expect(ops[0]).toMatchObject({ id: entityIdOf(home, 'decision', d.id), entity: { name: 'We adopt RetryPolicy for all billing jobs' } });
  });

  it('a closed decision gives one entity delete and no inserts', () => {
    saveDecision(home, T, { decisionText: 'Keep this one' });
    const gone = saveDecision(home, T, { decisionText: 'Close this one' });
    extractGraph(home, T);
    // Flipped in SQL: closeDecision also drops the graph row itself, which would leave nothing to diff.
    onStore(home, (db) => db.prepare(`UPDATE decisions SET status = 'closed' WHERE id = ?`).run(gone.id));

    expect(deltaOf(home)).toEqual([{ op: 'deleteEntity', id: entityIdOf(home, 'decision', gone.id) }]);
  });

  it('a duplicate current entity gives one delete', () => {
    const d = saveDecision(home, T, { decisionText: 'Adopt Postgres' });
    extractGraph(home, T);
    const dup = insertEntity(home, T, { entityType: 'decision', name: 'Adopt Postgres', memoryId: d.memoryId, sourceObject: { type: 'decision', id: d.id } });

    expect(deltaOf(home)).toEqual([{ op: 'deleteEntity', id: dup.id }]);
  });

  it('an entity with no source object gives one delete', () => {
    const d = saveDecision(home, T, { decisionText: 'Adopt Postgres' });
    extractGraph(home, T);
    const loose = insertEntity(home, T, { entityType: 'system', name: 'Postgres', memoryId: d.memoryId });

    expect(deltaOf(home)).toEqual([{ op: 'deleteEntity', id: loose.id }]);
  });
});
