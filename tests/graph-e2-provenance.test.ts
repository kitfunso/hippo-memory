/**
 * v38 E2-provenance: graph entity/relation provenance is anchored to the authoritative
 * E2 object (decision/policy/customer-note/project-brief), not the decaying memory
 * mirror. An in-force E2 object STAYS in the entities/relations tables after its mirror
 * memory is forgotten or consolidation-pruned.
 * Docs: docs/plans/2026-06-03-graph-e2-provenance.md
 *
 * Real DB, no mocks (mirrors tests/graph-extract.test.ts + tests/graph-store.test.ts).
 * The success criterion is asserted by querying the entities/relations TABLES directly,
 * not via recall (recall surfacing of mirror-less nodes is an out-of-scope follow-up).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { saveDecision, closeDecision } from '../src/decisions.js';
import { savePolicy } from '../src/policies.js';
import { extractGraph } from '../src/graph-extract.js';
import { insertEntity, loadEntities, loadRelations } from '../src/graph.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const T = 'default';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graph-e2-prov-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

/** Write a memory and (optionally) force its kind. Returns its id. */
function addMemory(home: string, kind: 'distilled' | 'superseded' | 'raw'): string {
  const mem = createMemory('graph e2-provenance test memory', {
    tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: T,
  });
  writeEntry(home, mem, { actor: 'test' });
  if (kind !== 'distilled') {
    const db = openHippoDb(home);
    try { db.prepare(`UPDATE memories SET kind = ? WHERE id = ?`).run(kind, mem.id); }
    finally { closeHippoDb(db); }
  }
  return mem.id;
}

/** Raw rows straight out of the entities table (the success criterion is a TABLE query). */
function entityRows(home: string): Array<{
  id: number; name: string; memory_id: string | null;
  source_object_type: string | null; source_object_id: number | null;
}> {
  const db = openHippoDb(home);
  try {
    return db.prepare(
      `SELECT id, name, memory_id, source_object_type, source_object_id FROM entities ORDER BY id`,
    ).all() as never;
  } finally { closeHippoDb(db); }
}

function relationRows(home: string): Array<{
  id: number; from_entity_id: number; to_entity_id: number; rel_type: string;
  memory_id: string | null; source_object_type: string | null; source_object_id: number | null;
}> {
  const db = openHippoDb(home);
  try {
    return db.prepare(
      `SELECT id, from_entity_id, to_entity_id, rel_type, memory_id, source_object_type, source_object_id FROM relations ORDER BY id`,
    ).all() as never;
  } finally { closeHippoDb(db); }
}

describe('v38 E2-provenance (graph anchored to the authoritative E2 object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('extract: a policy + a decision that mentions it produce entities + a references arc', () => {
    const policy = savePolicy(home, T, {
      policyName: 'Data Retention Policy',
      policyText: 'Delete logs after 90 days',
    });
    const decision = saveDecision(home, T, {
      decisionText: 'Adopt the Data Retention Policy for all log pipelines',
    });

    const r = extractGraph(home, T);
    expect(r.entities).toBe(2);
    expect(r.references).toBe(1); // the decision references the policy by name

    const ents = entityRows(home);
    expect(ents.length).toBe(2);
    const policyEnt = ents.find((e) => e.source_object_type === 'policy')!;
    const decisionEnt = ents.find((e) => e.source_object_type === 'decision')!;
    expect(policyEnt.source_object_id).toBe(policy.id);
    expect(decisionEnt.source_object_id).toBe(decision.id);
    // both mirrors are live, so memory_id is set on the freshly-extracted rows.
    expect(policyEnt.memory_id).not.toBeNull();
    expect(decisionEnt.memory_id).not.toBeNull();

    const rels = relationRows(home);
    expect(rels.length).toBe(1);
    expect(rels[0].rel_type).toBe('references');
    expect(rels[0].from_entity_id).toBe(decisionEnt.id); // decision -> policy
    expect(rels[0].to_entity_id).toBe(policyEnt.id);
    expect(rels[0].source_object_type).toBe('decision');
    expect(rels[0].source_object_id).toBe(decision.id);
  });

  it('SUCCESS CRITERION: forget the decision mirror -> the active decision STAYS in the entities table (memory_id NULL, source_object set); its references arc preserved', () => {
    const policy = savePolicy(home, T, {
      policyName: 'Data Retention Policy',
      policyText: 'Delete logs after 90 days',
    });
    const decision = saveDecision(home, T, {
      decisionText: 'Adopt the Data Retention Policy for all log pipelines',
    });

    // Forget ONLY the decision's mirror memory. decisions.memory_id -> NULL (ON DELETE SET
    // NULL); the decision row stays active and authoritative.
    deleteEntry(home, decision.memoryId!);

    const r = extractGraph(home, T);
    expect(r.entities).toBe(2); // BOTH still extracted (the forgotten-mirror decision survives)
    expect(r.references).toBe(1); // the references arc is preserved (provenance is the object)

    const ents = entityRows(home);
    const decisionEnt = ents.find((e) => e.source_object_type === 'decision')!;
    expect(decisionEnt).toBeDefined();
    expect(decisionEnt.memory_id).toBeNull();           // mirror gone
    expect(decisionEnt.source_object_id).toBe(decision.id); // anchored to the object

    const policyEnt = ents.find((e) => e.source_object_type === 'policy')!;
    expect(policyEnt.memory_id).not.toBeNull();          // policy mirror still live

    const rels = relationRows(home);
    expect(rels.length).toBe(1);
    expect(rels[0].rel_type).toBe('references');
    expect(rels[0].from_entity_id).toBe(decisionEnt.id);
    expect(rels[0].memory_id).toBeNull();               // edge mirror gone, anchored to object
    expect(rels[0].source_object_type).toBe('decision');
    expect(rels[0].source_object_id).toBe(decision.id);

    // It is verifiable in loadEntities too (the API maps the object columns).
    const apiEnt = loadEntities(home, T, { limit: 100 }).find((e) => e.sourceObjectType === 'decision')!;
    expect(apiEnt.memoryId).toBeNull();
    expect(apiEnt.sourceObjectId).toBe(decision.id);
  });

  it('a closed E2 object is excluded from the graph (status, not mirror presence, drives exclusion)', () => {
    const keep = saveDecision(home, T, { decisionText: 'Keep this active decision' });
    const gone = saveDecision(home, T, { decisionText: 'Retire this one' });
    closeDecision(home, T, gone.id);

    extractGraph(home, T);
    const ents = entityRows(home);
    expect(ents.length).toBe(1);
    expect(ents[0].source_object_id).toBe(keep.id);
    expect(ents.some((e) => e.source_object_id === gone.id)).toBe(false);
  });

  it('the no-raw invariant holds: inserting an entity that references a raw memory still ABORTs', () => {
    const raw = addMemory(home, 'raw');
    expect(() => insertEntity(home, T, { entityType: 'system', name: 'x', memoryId: raw }))
      .toThrow(/raw|consolidated/i);
    // and via a direct raw SQL INSERT claiming distilled -> the trigger ABORTs.
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(
        `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
         VALUES (?, 'system', 'x', ?, 'distilled', ?)`,
      ).run(T, raw, new Date().toISOString())).toThrow(/source_kind must equal|raw|consolidated/i);
    } finally { closeHippoDb(db); }
  });

  it('the all-null guard: inserting an entity with neither memory nor source_object ABORTs', () => {
    // helper-level rejection.
    expect(() => insertEntity(home, T, { entityType: 'system', name: 'x' }))
      .toThrow(/needs a memory or a source object/i);
    // direct raw SQL with both null -> the BEFORE INSERT trigger ABORTs.
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(
        `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'system', 'x', NULL, 'distilled', NULL, NULL, ?)`,
      ).run(T, new Date().toISOString())).toThrow(/needs a memory or a (complete )?source object/i);
    } finally { closeHippoDb(db); }
  });

  it('P2-B guard (codex): memory NULL + source_object_id set + source_object_type NULL ABORTs (incomplete object provenance)', () => {
    // The first guard WHEN requires BOTH source_object columns when memory is null, so an
    // id-set/type-null row cannot slip past (previously the type-keyed CASE arms were all
    // false on a NULL type, accepting a provenance-less row).
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(
        `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'decision', 'x', NULL, 'distilled', NULL, 7, ?)`,
      ).run(T, new Date().toISOString())).toThrow(/set together|all-or-none/i);
    } finally { closeHippoDb(db); }
  });

  it('object-path guard: inserting an entity pointing at a non-existent / wrong-tenant E2 row ABORTs', () => {
    // memory-null + a source_object that does not exist -> ABORT (helper + trigger).
    expect(() => insertEntity(home, T, { entityType: 'decision', name: 'ghost', sourceObject: { type: 'decision', id: 99999 } }))
      .toThrow(/not found|active\/superseded|active|superseded/i);
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(
        `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'decision', 'ghost', NULL, 'distilled', 'decision', 99999, ?)`,
      ).run(T, new Date().toISOString())).toThrow(/source_object must reference|active|superseded/i);
    } finally { closeHippoDb(db); }
  });

  it('mirror forget on a memory-only entity succeeds and leaves an all-null row (UPDATE trigger tolerates the FK SET NULL)', () => {
    // Insert a memory-only entity (no source_object), then forget the memory. The FK
    // ON DELETE SET NULL nulls memory_id. NOTE (deviation from plan premise, verified):
    // node:sqlite DOES fire the BEFORE UPDATE trigger from the FK action even with
    // recursive_triggers OFF, so the all-null ABORT was removed from the UPDATE triggers
    // (kept on INSERT). The delete therefore succeeds and the row survives all-null.
    const md = addMemory(home, 'distilled');
    const e = insertEntity(home, T, { entityType: 'system', name: 'mem-only', memoryId: md });
    expect(() => deleteEntry(home, md)).not.toThrow();
    const ents = entityRows(home);
    const row = ents.find((r) => r.id === e.id)!;
    expect(row).toBeDefined();
    expect(row.memory_id).toBeNull();
    expect(row.source_object_id).toBeNull(); // all-null, intentionally tolerated post-forget
  });

  it('supersedes + references edges survive a mirror forget on an endpoint', () => {
    // A policy referenced by a decision, and a decision superseded by a successor. Forget
    // the successor's mirror (a supersedes-edge endpoint) AND the referencing decision's
    // mirror; both edges must still be present (anchored to their source objects).
    const policy = savePolicy(home, T, {
      policyName: 'Data Retention Policy',
      policyText: 'Delete logs after 90 days',
    });
    const v1 = savePolicy(home, T, {
      policyName: 'Access Control Policy',
      policyText: 'least privilege v1',
    });
    const v2 = savePolicy(home, T, {
      policyName: 'Access Control Policy',
      policyText: 'least privilege v2',
      supersedesPolicyId: v1.id,
    });
    const decision = saveDecision(home, T, {
      decisionText: 'Adopt the Data Retention Policy across all services',
    });

    // Forget the successor (v2) mirror AND the decision mirror.
    deleteEntry(home, v2.memoryId!);
    deleteEntry(home, decision.memoryId!);

    extractGraph(home, T);
    const rels = relationRows(home);
    const sup = rels.find((r) => r.rel_type === 'supersedes')!;
    const ref = rels.find((r) => r.rel_type === 'references')!;

    // supersedes edge: present, anchored to the successor (policy v2) object, mirror gone.
    expect(sup).toBeDefined();
    expect(sup.memory_id).toBeNull();
    expect(sup.source_object_type).toBe('policy');
    expect(sup.source_object_id).toBe(v2.id);

    // references edge: present, anchored to the decision object, mirror gone.
    expect(ref).toBeDefined();
    expect(ref.memory_id).toBeNull();
    expect(ref.source_object_type).toBe('decision');
    expect(ref.source_object_id).toBe(decision.id);

    // The referenced policy entity is still there with a live mirror.
    const policyEnt = entityRows(home).find((e) => e.source_object_id === policy.id && e.source_object_type === 'policy')!;
    expect(policyEnt).toBeDefined();
  });

  it('P2 (codex round 2): a VALID memory + a BAD source_object is REJECTED (object validated even when memory present)', () => {
    // The dual-provenance object pointer is validated whenever provided, not only when
    // memory is null - so a wrong/closed/nonexistent object cannot ride along with a live
    // memory and become a forget-blocking landmine after ON DELETE SET NULL.
    const md = addMemory(home, 'distilled');
    expect(() => insertEntity(home, T, {
      entityType: 'decision', name: 'x', memoryId: md, sourceObject: { type: 'decision', id: 99999 },
    })).toThrow(/not found|active|superseded/i);

    // raw SQL: live distilled memory + bad object -> the INSERT trigger validates the object too.
    const md2 = addMemory(home, 'distilled');
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(
        `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'decision', 'x', ?, 'distilled', 'decision', 99999, ?)`,
      ).run(T, md2, new Date().toISOString())).toThrow(/source_object must reference|active|superseded/i);
    } finally { closeHippoDb(db); }
  });

  it('P2 round-4 (codex): a stale-missing mirror is tolerated when a valid object is present (rebuild not rolled back)', () => {
    // The extraction race: a memory id that no longer exists (forgotten mid-rebuild) but a valid
    // source object. insertEntity must anchor to the object (memory_id null), NOT throw - else a
    // mirror forgotten during a rebuild would roll back the WHOLE tenant rebuild.
    const policy = savePolicy(home, T, { policyName: 'Retention', policyText: 'p' });
    const ent = insertEntity(home, T, {
      entityType: 'policy', name: 'Retention', memoryId: 'sem_doesnotexist', sourceObject: { type: 'policy', id: policy.id },
    });
    expect(ent.memoryId).toBeNull();            // dead mirror pointer dropped
    expect(ent.sourceObjectId).toBe(policy.id); // anchored to the object
    // a stale-missing mirror with NO object still throws (no provenance to fall back on).
    expect(() => insertEntity(home, T, { entityType: 'system', name: 'x', memoryId: 'sem_doesnotexist' }))
      .toThrow(/not found/i);
  });

  it('P2 round-4 (codex): an explicit UPDATE re-pointing a row to a bad object ABORTs (object cols changed); memory-only SET NULL still does not', () => {
    const policy = savePolicy(home, T, { policyName: 'Retention', policyText: 'p' });
    extractGraph(home, T);
    const polEnt = entityRows(home).find((e) => e.source_object_type === 'policy')!;
    const db = openHippoDb(home);
    try {
      // explicit re-point to a nonexistent object -> object cols changed -> object path validated -> ABORT.
      expect(() => db.prepare(`UPDATE entities SET source_object_id = 99999 WHERE id = ?`).run(polEnt.id))
        .toThrow(/source_object must reference|active|superseded/i);
      // half-set via UPDATE -> all-or-none ABORT.
      expect(() => db.prepare(`UPDATE entities SET source_object_type = NULL WHERE id = ?`).run(polEnt.id))
        .toThrow(/set together|all-or-none/i);
    } finally { closeHippoDb(db); }
    // (the memory-only SET NULL not-blocked case is covered by the memory-only forget test above.)
  });

  it('P2 round-5 (codex): a tenant-only move of an object-backed (mirrorless) row revalidates the object and ABORTs', () => {
    const policy = savePolicy(home, T, { policyName: 'Retention', policyText: 'p' });
    // object-only (mirrorless) entity in tenant T - the memory-path tenant check does not apply.
    const ent = insertEntity(home, T, { entityType: 'policy', name: 'Retention', sourceObject: { type: 'policy', id: policy.id } });
    expect(ent.memoryId).toBeNull();
    const db = openHippoDb(home);
    try {
      // moving it to another tenant: the object-validation gate now includes tenant change, so the
      // object is re-checked against the NEW tenant (policy is in T, not 'other-tenant') -> ABORT.
      expect(() => db.prepare(`UPDATE entities SET tenant_id = 'other-tenant' WHERE id = ?`).run(ent.id))
        .toThrow(/source_object must reference|active|superseded/i);
    } finally { closeHippoDb(db); }
  });

  it('P2-A close lifecycle (codex): closing a MIRRORLESS object removes its graph rows directly (no rebuild)', () => {
    const policy = savePolicy(home, T, { policyName: 'Data Retention Policy', policyText: 'Delete logs after 90 days' });
    const decision = saveDecision(home, T, { decisionText: 'Adopt the Data Retention Policy widely' });
    // Forget the decision mirror, then extract -> the decision is in the graph, mirrorless.
    deleteEntry(home, decision.memoryId!);
    extractGraph(home, T);
    expect(entityRows(home).some((e) => e.source_object_type === 'decision' && e.source_object_id === decision.id)).toBe(true);
    expect(relationRows(home).length).toBe(1); // decision -> policy references arc

    // Close the mirrorless decision. close* cannot enqueue a rebuild (no mirror to key the
    // queue), so it must drop the decision's graph rows DIRECTLY. NO extractGraph after close.
    closeDecision(home, T, decision.id);

    expect(entityRows(home).some((e) => e.source_object_type === 'decision' && e.source_object_id === decision.id)).toBe(false); // gone
    expect(relationRows(home).some((r) => r.source_object_type === 'decision' && r.source_object_id === decision.id)).toBe(false); // edge gone
    // the policy entity (untouched, live mirror) remains.
    expect(entityRows(home).some((e) => e.source_object_type === 'policy' && e.source_object_id === policy.id)).toBe(true);
  });

  it('P1 (codex round 3): forgetting the mirror of a CLOSED-but-not-yet-rebuilt object does NOT block the delete (core sleep/forget safe)', () => {
    // A mirror-present close enqueues a rebuild but leaves the graph row pointing at the
    // now-closed object until that rebuild runs. If the mirror is then forgotten or pruned
    // (sleep deletes memories BEFORE the graph drain), the FK ON DELETE SET NULL fires the
    // BEFORE UPDATE trigger - which must NOT abort the delete on the object's (closed) status.
    const decision = saveDecision(home, T, { decisionText: 'Adopt the retention rule for logs' });
    extractGraph(home, T);
    expect(entityRows(home).length).toBe(1); // entity created with a live mirror + object (active)

    // Close removes the object's graph rows DIRECTLY (deterministic), so it never lingers.
    closeDecision(home, T, decision.id);
    expect(entityRows(home).length).toBe(0); // gone immediately, not lingering until a rebuild

    // Forgetting the now-orphaned mirror afterwards must not throw - and with the object-status
    // checks removed from the UPDATE trigger, even a lingering row (if removal had failed soft)
    // would not block the SET NULL. Core sleep/forget stays safe.
    expect(() => deleteEntry(home, decision.memoryId!)).not.toThrow();
  });
});
