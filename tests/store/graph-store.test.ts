import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { openHippoDb, closeHippoDb, withWriteScope } from '../../src/db/index.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { insertEntityRow, insertRelationRow, updateEntityRow } from '../../src/store/sqlite/graph/graph-writes.js';
import { MAX_ENTITY_NAME_LEN } from '../../src/base/records/entity-name.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadExtractionQueue } from '../_helpers/graph-queue.js';
import {
  deleteEntry,
  markPendingProcessedUpTo,
  markGraphDirty,
  loadEntitiesByIds,
  loadEntities,
  loadRelations,
} from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry } = sessionPerTest();

function addMemory(home: string, tenant: string, kind: 'distilled' | 'superseded' | 'raw'): string {
  const mem = createMemory('graph source memory for guard tests', {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tags: [],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'test',
    tenantId: tenant,
  });
  writeEntry(home, mem, { actor: 'test' });
  if (kind !== 'distilled') {
    const db = openHippoDb(home);
    try {
      db.prepare(`UPDATE memories SET kind = ? WHERE id = ?`).run(kind, mem.id);
    } finally {
      closeHippoDb(db);
    }
  }
  return mem.id;
}
function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: query selects a single aliased "c" column, so the result row always has that field.
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  } finally {
    closeHippoDb(db);
  }
}

describe('graph store (graph-on-consolidated guard)', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('graph');
  });

  it('insertEntity from a distilled / superseded memory sets source_kind; insertRelation links them', async () => {
    const md = addMemory(home, 'default', 'distilled');
    const ms = addMemory(home, 'default', 'superseded');
    const a = insertEntityAt(home, 'default', { entityType: 'customer', name: 'Acme', memoryId: md });
    const b = insertEntityAt(home, 'default', { entityType: 'person', name: 'Jordan', memoryId: ms });
    expect(a.sourceKind).toBe('distilled');
    expect(b.sourceKind).toBe('superseded');
    const rel = insertRelationAt(home, 'default', {
      fromEntityId: a.id,
      toEntityId: b.id,
      relType: 'owns',
      memoryId: md,
    });
    expect(rel.relType).toBe('owns');
    expect(rel.sourceKind).toBe('distilled');
    expect((await loadEntitiesByIds(home, 'default', [a.id]))[0]!.name).toBe('Acme');
  });

  it("every graph writer runs on the caller's handle, so a rolled-back transaction keeps none of its writes", async () => {
    const writers = Object.keys(await import('../../src/store/sqlite/graph/graph-writes.js'));
    for (const rootForm of ['insertEntity', 'updateEntity', 'insertRelation']) expect(writers).not.toContain(rootForm);
    const md = addMemory(home, 'default', 'distilled');
    const kept = insertEntityAt(home, 'default', { entityType: 'system', name: 'kept', memoryId: md });
    const txDb = openHippoDb(home);
    try {
      expect(() =>
        withWriteScope(txDb, 'graph_rollback_test', () => {
          const added = insertEntityRow(txDb, 'default', { entityType: 'system', name: 'added', memoryId: md });
          insertRelationRow(txDb, 'default', {
            fromEntityId: kept.id,
            toEntityId: added.id,
            relType: 'depends-on',
            memoryId: md,
          });
          updateEntityRow(txDb, 'default', kept.id, { name: 'renamed', memoryId: md });
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
    } finally {
      closeHippoDb(txDb);
    }
    expect(loadEntities(home, 'default', { limit: 10 }).map((e) => e.name)).toEqual(['kept']);
    expect(countRows(home, 'relations')).toBe(0);
  });

  it('CRITERION 1: a raw-FK entity is rejected via the helper AND via a direct raw SQL INSERT (trigger ABORTs)', () => {
    const raw = addMemory(home, 'default', 'raw');
    expect(() => insertEntityAt(home, 'default', { entityType: 'system', name: 'x', memoryId: raw })).toThrow(
      /raw|consolidated/i,
    );
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
          VALUES ('default', 'system', 'x', ?, 'distilled', ?)`).run(raw, new Date().toISOString());
      }).toThrow(/source_kind must equal the referenced memory kind/);
    } finally {
      closeHippoDb(db);
    }
    expect(countRows(home, 'entities')).toBe(0);
  });

  it('UPDATE-path guard: cannot move a graph row onto a raw memory or fake source_kind via raw SQL UPDATE', () => {
    const md = addMemory(home, 'default', 'distilled');
    const raw = addMemory(home, 'default', 'raw');
    const e = insertEntityAt(home, 'default', { entityType: 'project', name: 'p', memoryId: md });
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`UPDATE entities SET memory_id = ? WHERE id = ?`).run(raw, e.id)).toThrow(
        /source_kind must equal the referenced memory kind/,
      );
      expect(() => db.prepare(`UPDATE entities SET source_kind = 'superseded' WHERE id = ?`).run(e.id)).toThrow(
        /source_kind must equal the referenced memory kind/,
      );
      // SAFETY: query selects only memory_id and source_kind for the entity row inserted above.
      const row = db.prepare(`SELECT memory_id, source_kind FROM entities WHERE id = ?`).get(e.id) as {
        memory_id: string;
        source_kind: string;
      };
      expect(row.memory_id).toBe(md);
      expect(row.source_kind).toBe('distilled');
    } finally {
      closeHippoDb(db);
    }
  });

  it('lying source_kind on INSERT is rejected (raw SQL: distilled memory but source_kind=superseded)', () => {
    const md = addMemory(home, 'default', 'distilled');
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
          VALUES ('default', 'system', 'x', ?, 'superseded', ?)`).run(md, new Date().toISOString());
      }).toThrow(/source_kind must equal the referenced memory kind/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('cross-tenant entity->memory rejected (helper + raw SQL trigger)', () => {
    const mb = addMemory(home, 'tenant-b', 'distilled');
    expect(() => insertEntityAt(home, 'tenant-a', { entityType: 'customer', name: 'x', memoryId: mb })).toThrow(
      /another tenant/,
    );
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
          VALUES ('tenant-a', 'customer', 'x', ?, 'distilled', ?)`).run(mb, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('cross-tenant relation->entity rejected (helper + raw SQL trigger)', () => {
    const ma = addMemory(home, 'tenant-a', 'distilled');
    const mb = addMemory(home, 'tenant-b', 'distilled');
    const ea = insertEntityAt(home, 'tenant-a', { entityType: 'system', name: 'a', memoryId: ma });
    const eb = insertEntityAt(home, 'tenant-b', { entityType: 'system', name: 'b', memoryId: mb });
    expect(() =>
      insertRelationAt(home, 'tenant-a', {
        fromEntityId: ea.id,
        toEntityId: eb.id,
        relType: 'depends-on',
        memoryId: ma,
      }),
    ).toThrow(/another tenant/);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO relations(tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, created_at)
          VALUES ('tenant-a', ?, ?, 'depends-on', ?, 'distilled', ?)`).run(ea.id, eb.id, ma, new Date().toISOString());
      }).toThrow(/to_entity tenant|from_entity tenant/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('CHECK constraints reject bad entity_type / rel_type / source_kind (raw SQL)', () => {
    const md = addMemory(home, 'default', 'distilled');
    const db = openHippoDb(home);
    try {
      expect(() =>
        db
          .prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
        VALUES ('default', 'alien', 'x', ?, 'distilled', ?)`)
          .run(md, 't'),
      ).toThrow(/CHECK|constraint/i);
      // trigger fires before the CHECK in SQLite, so it raises the trigger message.
      expect(() =>
        db
          .prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
        VALUES ('default', 'system', 'x', ?, 'raw', ?)`)
          .run(md, 't'),
      ).toThrow(/source_kind must equal|CHECK|constraint/i);
      const e = insertEntityAt(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
      expect(() =>
        db
          .prepare(`INSERT INTO relations(tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, created_at)
        VALUES ('default', ?, ?, 'frobnicates', ?, 'distilled', ?)`)
          .run(e.id, e.id, md, 't'),
      ).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
    }
  });

  it('helper rejects bad entityType/relType and over-cap name before touching the DB', () => {
    const md = addMemory(home, 'default', 'distilled');
    // @ts-expect-error runtime validation
    expect(() => insertEntityAt(home, 'default', { entityType: 'alien', name: 'x', memoryId: md })).toThrow(
      /entityType must be one of/,
    );
    expect(() => insertEntityAt(home, 'default', { entityType: 'system', name: '  ', memoryId: md })).toThrow(
      /name is required/,
    );
    expect(() =>
      insertEntityAt(home, 'default', {
        entityType: 'system',
        name: 'z'.repeat(MAX_ENTITY_NAME_LEN + 1),
        memoryId: md,
      }),
    ).toThrow(/name exceeds/);
  });

  it('markGraphDirty: distilled enqueues; raw is not enqueued; queue kind-mismatch UPDATE ABORTs; markProcessed', () => {
    const md = addMemory(home, 'default', 'distilled');
    const raw = addMemory(home, 'default', 'raw');
    markGraphDirty(home, 'default', md);
    const [q] = loadExtractionQueue(home, 'default');
    expect(q!.status).toBe('pending');
    expect(q!.kind).toBe('distilled');
    markGraphDirty(home, 'default', raw);
    expect(loadExtractionQueue(home, 'default').map((item) => item.memoryId)).toEqual([md]);
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`UPDATE graph_extraction_queue SET memory_id = ? WHERE id = ?`).run(raw, q!.id)).toThrow(
        /kind must equal the referenced memory kind/,
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO graph_extraction_queue(tenant_id, memory_id, kind, status, enqueued_at) VALUES ('default', ?, 'distilled', 'pending', ?)`,
          )
          .run(raw, new Date().toISOString()),
      ).toThrow(/kind must equal the referenced memory kind/);
    } finally {
      closeHippoDb(db);
    }
    expect(markPendingProcessedUpTo(home, 'default', q!.id)).toBe(1);
    const [done] = loadExtractionQueue(home, 'default', { status: 'processed' });
    expect(done!.status).toBe('processed');
    expect(done!.processedAt).not.toBeNull();
    expect(markPendingProcessedUpTo(home, 'default', q!.id)).toBe(0);
    expect(loadExtractionQueue(home, 'default', { status: 'pending' }).length).toBe(0);
    expect(loadExtractionQueue(home, 'default', { status: 'processed' }).length).toBe(1);
  });

  it('forgetting a memory deletes its memory-only graph rows; queue still cascades', async () => {
    const md = addMemory(home, 'default', 'distilled');
    const a = insertEntityAt(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
    const b = insertEntityAt(home, 'default', { entityType: 'system', name: 'b', memoryId: md });
    insertRelationAt(home, 'default', { fromEntityId: a.id, toEntityId: b.id, relType: 'depends-on', memoryId: md });
    markGraphDirty(home, 'default', md);
    expect(countRows(home, 'entities')).toBe(2);
    expect(countRows(home, 'relations')).toBe(1);
    expect(countRows(home, 'graph_extraction_queue')).toBe(1);
    deleteEntry(home, md);
    expect(countRows(home, 'entities')).toBe(0);
    expect(countRows(home, 'relations')).toBe(0);
    expect(countRows(home, 'graph_extraction_queue')).toBe(0);
  });

  it('REVERSE guard: a graph-referenced memory is immutable in kind/tenant (raw, superseded, or tenant move all ABORT)', () => {
    const md = addMemory(home, 'default', 'distilled');
    insertEntityAt(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`UPDATE memories SET kind = 'raw' WHERE id = ?`).run(md)).toThrow(
        /while the graph references it/,
      );
      expect(() => db.prepare(`UPDATE memories SET kind = 'superseded' WHERE id = ?`).run(md)).toThrow(
        /while the graph references it/,
      );
      expect(() => db.prepare(`UPDATE memories SET tenant_id = 'tenant-x' WHERE id = ?`).run(md)).toThrow(
        /while the graph references it/,
      );
      // SAFETY: query selects only kind and tenant_id for the memory row created above.
      const row = db.prepare(`SELECT kind, tenant_id FROM memories WHERE id = ?`).get(md) as {
        kind: string;
        tenant_id: string;
      };
      expect(row.kind).toBe('distilled');
      expect(row.tenant_id).toBe('default');
    } finally {
      closeHippoDb(db);
    }
    const free = addMemory(home, 'default', 'distilled');
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE memories SET kind = 'superseded' WHERE id = ?`).run(free)).not.toThrow();
      expect(db2.prepare(`SELECT kind FROM memories WHERE id = ?`).get(free)).toEqual({ kind: 'superseded' });
    } finally {
      closeHippoDb(db2);
    }
  });

  it('REVERSE guard: a relation-endpoint entity cannot be moved cross-tenant via raw UPDATE', () => {
    const md = addMemory(home, 'default', 'distilled');
    const mb = addMemory(home, 'tenant-b', 'distilled');
    const a = insertEntityAt(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
    const b = insertEntityAt(home, 'default', { entityType: 'system', name: 'b', memoryId: md });
    insertRelationAt(home, 'default', { fromEntityId: a.id, toEntityId: b.id, relType: 'depends-on', memoryId: md });
    const db = openHippoDb(home);
    try {
      expect(() =>
        db
          .prepare(`UPDATE entities SET tenant_id = 'tenant-b', memory_id = ?, source_kind = 'distilled' WHERE id = ?`)
          .run(mb, a.id),
      ).toThrow(/while a relation references it/);
      expect(db.prepare(`SELECT tenant_id FROM entities WHERE id = ?`).get(a.id)).toEqual({ tenant_id: 'default' });
    } finally {
      closeHippoDb(db);
    }
    const cmem = addMemory(home, 'default', 'distilled');
    const c = insertEntityAt(home, 'default', { entityType: 'system', name: 'c', memoryId: cmem });
    const db2 = openHippoDb(home);
    try {
      expect(() =>
        db2
          .prepare(`UPDATE entities SET tenant_id = 'tenant-b', memory_id = ?, source_kind = 'distilled' WHERE id = ?`)
          .run(mb, c.id),
      ).not.toThrow();
      expect(db2.prepare(`SELECT tenant_id, memory_id, source_kind FROM entities WHERE id = ?`).get(c.id)).toEqual({
        tenant_id: 'tenant-b',
        memory_id: mb,
        source_kind: 'distilled',
      });
    } finally {
      closeHippoDb(db2);
    }
  });

  it('loadEntities / loadRelations filters + tenant isolation', () => {
    const md = addMemory(home, 'default', 'distilled');
    const a = insertEntityAt(home, 'default', { entityType: 'customer', name: 'Acme', memoryId: md });
    insertEntityAt(home, 'default', { entityType: 'person', name: 'Jo', memoryId: md });
    expect(loadEntities(home, 'default').length).toBe(2);
    expect(loadEntities(home, 'default', { entityType: 'customer' }).map((e) => e.id)).toEqual([a.id]);
    expect(loadEntities(home, 'other-tenant').length).toBe(0);
    insertRelationAt(home, 'default', { fromEntityId: a.id, toEntityId: a.id, relType: 'references', memoryId: md });
    expect(loadRelations(home, 'default', { fromEntityId: a.id }).length).toBe(1);
  });
});
