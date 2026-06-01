/**
 * E3.3 graph-on-consolidated guard - store-layer tests.
 * Docs: docs/plans/2026-06-01-e3-graph-guard.md
 *
 * The graph must NEVER index the raw layer. These tests pin the DB-level guard
 * (CHECK + BEFORE INSERT/UPDATE triggers) as the unbypassable invariant, plus the
 * src/graph.ts helper API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  insertEntity,
  insertRelation,
  loadEntityById,
  loadEntities,
  loadRelations,
  enqueueExtraction,
  loadExtractionQueue,
  markExtractionProcessed,
  MAX_ENTITY_NAME_LEN,
} from '../src/graph.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graph-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
/** Write a memory and force its kind (default writes are 'distilled'). Setting kind
 *  to 'raw' is allowed (the append-only trigger is BEFORE DELETE, not UPDATE). */
function addMemory(home: string, tenant: string, kind: 'distilled' | 'superseded' | 'raw'): string {
  const mem = createMemory('graph source memory for guard tests', { tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: tenant });
  writeEntry(home, mem, { actor: 'test' });
  if (kind !== 'distilled') {
    const db = openHippoDb(home);
    try { db.prepare(`UPDATE memories SET kind = ? WHERE id = ?`).run(kind, mem.id); }
    finally { closeHippoDb(db); }
  }
  return mem.id;
}
function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c; }
  finally { closeHippoDb(db); }
}

describe('graph store (E3.3 graph-on-consolidated guard)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => safeRmSync(home));

  it('insertEntity from a distilled / superseded memory sets source_kind; insertRelation links them', () => {
    const md = addMemory(home, 'default', 'distilled');
    const ms = addMemory(home, 'default', 'superseded');
    const a = insertEntity(home, 'default', { entityType: 'customer', name: 'Acme', memoryId: md });
    const b = insertEntity(home, 'default', { entityType: 'person', name: 'Jordan', memoryId: ms });
    expect(a.sourceKind).toBe('distilled');
    expect(b.sourceKind).toBe('superseded');
    const rel = insertRelation(home, 'default', { fromEntityId: a.id, toEntityId: b.id, relType: 'owns', memoryId: md });
    expect(rel.relType).toBe('owns');
    expect(rel.sourceKind).toBe('distilled');
    expect(loadEntityById(home, 'default', a.id)!.name).toBe('Acme');
  });

  it('CRITERION 1: a raw-FK entity is rejected via the helper AND via a direct raw SQL INSERT (trigger ABORTs)', () => {
    const raw = addMemory(home, 'default', 'raw');
    // helper rejects
    expect(() => insertEntity(home, 'default', { entityType: 'system', name: 'x', memoryId: raw }))
      .toThrow(/raw|consolidated/i);
    // direct raw SQL INSERT (claiming source_kind='distilled') is rejected by the trigger
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
          VALUES ('default', 'system', 'x', ?, 'distilled', ?)`).run(raw, new Date().toISOString());
      }).toThrow(/source_kind must equal the referenced memory kind/);
    } finally { closeHippoDb(db); }
    expect(countRows(home, 'entities')).toBe(0);
  });

  it('UPDATE-path guard: cannot move a graph row onto a raw memory or fake source_kind via raw SQL UPDATE', () => {
    const md = addMemory(home, 'default', 'distilled');
    const raw = addMemory(home, 'default', 'raw');
    const e = insertEntity(home, 'default', { entityType: 'project', name: 'p', memoryId: md });
    const db = openHippoDb(home);
    try {
      // move memory_id to a raw memory -> ABORT (BEFORE UPDATE trigger)
      expect(() => db.prepare(`UPDATE entities SET memory_id = ? WHERE id = ?`).run(raw, e.id))
        .toThrow(/source_kind must equal the referenced memory kind/);
      // change source_kind to disagree with the (distilled) memory -> ABORT
      expect(() => db.prepare(`UPDATE entities SET source_kind = 'superseded' WHERE id = ?`).run(e.id))
        .toThrow(/source_kind must equal the referenced memory kind/);
      // the row is unchanged
      const row = db.prepare(`SELECT memory_id, source_kind FROM entities WHERE id = ?`).get(e.id) as { memory_id: string; source_kind: string };
      expect(row.memory_id).toBe(md);
      expect(row.source_kind).toBe('distilled');
    } finally { closeHippoDb(db); }
  });

  it('lying source_kind on INSERT is rejected (raw SQL: distilled memory but source_kind=superseded)', () => {
    const md = addMemory(home, 'default', 'distilled');
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
          VALUES ('default', 'system', 'x', ?, 'superseded', ?)`).run(md, new Date().toISOString());
      }).toThrow(/source_kind must equal the referenced memory kind/);
    } finally { closeHippoDb(db); }
  });

  it('cross-tenant entity->memory rejected (helper + raw SQL trigger)', () => {
    const mb = addMemory(home, 'tenant-b', 'distilled');
    expect(() => insertEntity(home, 'tenant-a', { entityType: 'customer', name: 'x', memoryId: mb }))
      .toThrow(/another tenant/);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
          VALUES ('tenant-a', 'customer', 'x', ?, 'distilled', ?)`).run(mb, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }
  });

  it('cross-tenant relation->entity rejected (helper + raw SQL trigger)', () => {
    const ma = addMemory(home, 'tenant-a', 'distilled');
    const mb = addMemory(home, 'tenant-b', 'distilled');
    const ea = insertEntity(home, 'tenant-a', { entityType: 'system', name: 'a', memoryId: ma });
    const eb = insertEntity(home, 'tenant-b', { entityType: 'system', name: 'b', memoryId: mb });
    expect(() => insertRelation(home, 'tenant-a', { fromEntityId: ea.id, toEntityId: eb.id, relType: 'depends-on', memoryId: ma }))
      .toThrow(/another tenant/);
    const db = openHippoDb(home);
    try {
      // raw SQL: relation in tenant-a referencing tenant-b's entity -> trigger ABORTs
      expect(() => {
        db.prepare(`INSERT INTO relations(tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, created_at)
          VALUES ('tenant-a', ?, ?, 'depends-on', ?, 'distilled', ?)`).run(ea.id, eb.id, ma, new Date().toISOString());
      }).toThrow(/to_entity tenant|from_entity tenant/);
    } finally { closeHippoDb(db); }
  });

  it('CHECK constraints reject bad entity_type / rel_type / source_kind (raw SQL)', () => {
    const md = addMemory(home, 'default', 'distilled');
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
        VALUES ('default', 'alien', 'x', ?, 'distilled', ?)`).run(md, 't')).toThrow(/CHECK|constraint/i);
      // source_kind='raw' is doubly-invalid (CHECK + trigger); the BEFORE INSERT
      // trigger fires before the CHECK in SQLite, so it raises the trigger message.
      expect(() => db.prepare(`INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
        VALUES ('default', 'system', 'x', ?, 'raw', ?)`).run(md, 't')).toThrow(/source_kind must equal|CHECK|constraint/i);
      const e = insertEntity(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
      expect(() => db.prepare(`INSERT INTO relations(tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, created_at)
        VALUES ('default', ?, ?, 'frobnicates', ?, 'distilled', ?)`).run(e.id, e.id, md, 't')).toThrow(/CHECK|constraint/i);
    } finally { closeHippoDb(db); }
  });

  it('helper rejects bad entityType/relType and over-cap name before touching the DB', () => {
    const md = addMemory(home, 'default', 'distilled');
    // @ts-expect-error runtime validation
    expect(() => insertEntity(home, 'default', { entityType: 'alien', name: 'x', memoryId: md })).toThrow(/entityType must be one of/);
    expect(() => insertEntity(home, 'default', { entityType: 'system', name: '  ', memoryId: md })).toThrow(/name is required/);
    expect(() => insertEntity(home, 'default', { entityType: 'system', name: 'z'.repeat(MAX_ENTITY_NAME_LEN + 1), memoryId: md })).toThrow(/name exceeds/);
  });

  it('enqueueExtraction: distilled enqueues; raw rejected; queue kind-mismatch UPDATE ABORTs; markProcessed', () => {
    const md = addMemory(home, 'default', 'distilled');
    const raw = addMemory(home, 'default', 'raw');
    const q = enqueueExtraction(home, 'default', md);
    expect(q.status).toBe('pending');
    expect(q.kind).toBe('distilled');
    expect(() => enqueueExtraction(home, 'default', raw)).toThrow(/raw|consolidated/i);
    // queue UPDATE that re-points to raw / fakes kind ABORTs
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`UPDATE graph_extraction_queue SET memory_id = ? WHERE id = ?`).run(raw, q.id))
        .toThrow(/kind must equal the referenced memory kind/);
    } finally { closeHippoDb(db); }
    // status-only update (markProcessed) is allowed (guard fires only on memory_id/kind/tenant change)
    const done = markExtractionProcessed(home, 'default', q.id);
    expect(done.status).toBe('processed');
    expect(done.processedAt).not.toBeNull();
    expect(() => markExtractionProcessed(home, 'default', q.id)).toThrow(/not pending/);
    expect(loadExtractionQueue(home, 'default', { status: 'pending' }).length).toBe(0);
    expect(loadExtractionQueue(home, 'default', { status: 'processed' }).length).toBe(1);
  });

  it('ON DELETE CASCADE: forgetting a consolidated memory removes its entities + relations + queue rows', () => {
    const md = addMemory(home, 'default', 'distilled');
    const a = insertEntity(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
    const b = insertEntity(home, 'default', { entityType: 'system', name: 'b', memoryId: md });
    insertRelation(home, 'default', { fromEntityId: a.id, toEntityId: b.id, relType: 'depends-on', memoryId: md });
    enqueueExtraction(home, 'default', md);
    expect(countRows(home, 'entities')).toBe(2);
    expect(countRows(home, 'relations')).toBe(1);
    expect(countRows(home, 'graph_extraction_queue')).toBe(1);
    deleteEntry(home, md); // distilled deletes are allowed (raw is append-only); cascades to graph rows
    expect(countRows(home, 'entities')).toBe(0);
    expect(countRows(home, 'relations')).toBe(0);
    expect(countRows(home, 'graph_extraction_queue')).toBe(0);
  });

  it('REVERSE guard (codex P1+P2): a graph-referenced memory is immutable in kind/tenant (raw, superseded, or tenant move all ABORT)', () => {
    const md = addMemory(home, 'default', 'distilled');
    insertEntity(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
    const db = openHippoDb(home);
    try {
      // P1: reclassify the referenced memory to raw -> ABORT
      expect(() => db.prepare(`UPDATE memories SET kind = 'raw' WHERE id = ?`).run(md))
        .toThrow(/while the graph references it/);
      // P2: ANY kind change (e.g. distilled->superseded) -> ABORT (avoids stale source_kind)
      expect(() => db.prepare(`UPDATE memories SET kind = 'superseded' WHERE id = ?`).run(md))
        .toThrow(/while the graph references it/);
      // move the referenced memory cross-tenant -> ABORT
      expect(() => db.prepare(`UPDATE memories SET tenant_id = 'tenant-x' WHERE id = ?`).run(md))
        .toThrow(/while the graph references it/);
      const row = db.prepare(`SELECT kind, tenant_id FROM memories WHERE id = ?`).get(md) as { kind: string; tenant_id: string };
      expect(row.kind).toBe('distilled');
      expect(row.tenant_id).toBe('default');
    } finally { closeHippoDb(db); }
    // an UNreferenced consolidated memory can still change kind freely (guard fires only when referenced)
    const free = addMemory(home, 'default', 'distilled');
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE memories SET kind = 'superseded' WHERE id = ?`).run(free)).not.toThrow();
    } finally { closeHippoDb(db2); }
  });

  it('REVERSE guard (codex P2): a relation-endpoint entity cannot be moved cross-tenant via raw UPDATE', () => {
    const md = addMemory(home, 'default', 'distilled');
    const mb = addMemory(home, 'tenant-b', 'distilled');
    const a = insertEntity(home, 'default', { entityType: 'system', name: 'a', memoryId: md });
    const b = insertEntity(home, 'default', { entityType: 'system', name: 'b', memoryId: md });
    insertRelation(home, 'default', { fromEntityId: a.id, toEntityId: b.id, relType: 'depends-on', memoryId: md });
    const db = openHippoDb(home);
    try {
      // moving endpoint 'a' to tenant-b (with a tenant-b memory, so the entity<->memory
      // check would pass) must ABORT because a relation references it as an endpoint
      expect(() => db.prepare(`UPDATE entities SET tenant_id = 'tenant-b', memory_id = ?, source_kind = 'distilled' WHERE id = ?`).run(mb, a.id))
        .toThrow(/while a relation references it/);
      expect(db.prepare(`SELECT tenant_id FROM entities WHERE id = ?`).get(a.id)).toEqual({ tenant_id: 'default' });
    } finally { closeHippoDb(db); }
    // an entity NOT referenced by any relation can still move tenant (with a matching memory)
    const cmem = addMemory(home, 'default', 'distilled');
    const c = insertEntity(home, 'default', { entityType: 'system', name: 'c', memoryId: cmem });
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE entities SET tenant_id = 'tenant-b', memory_id = ?, source_kind = 'distilled' WHERE id = ?`).run(mb, c.id)).not.toThrow();
    } finally { closeHippoDb(db2); }
  });

  it('loadEntities / loadRelations filters + tenant isolation', () => {
    const md = addMemory(home, 'default', 'distilled');
    const a = insertEntity(home, 'default', { entityType: 'customer', name: 'Acme', memoryId: md });
    insertEntity(home, 'default', { entityType: 'person', name: 'Jo', memoryId: md });
    expect(loadEntities(home, 'default').length).toBe(2);
    expect(loadEntities(home, 'default', { entityType: 'customer' }).map((e) => e.id)).toEqual([a.id]);
    expect(loadEntities(home, 'other-tenant').length).toBe(0);
    insertRelation(home, 'default', { fromEntityId: a.id, toEntityId: a.id, relType: 'references', memoryId: md });
    expect(loadRelations(home, 'default', { fromEntityId: a.id }).length).toBe(1);
  });
});
