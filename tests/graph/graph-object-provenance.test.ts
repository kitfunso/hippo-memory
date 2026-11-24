import { describe, it, expect, beforeEach } from 'vitest';
import { closeObject } from '../../src/domain/objects/lifecycle.js';
import { CLI_ACTOR } from '../../src/base/scope/actor.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { DECISION } from '../../src/domain/objects/decisions.js';
import { extractGraph } from '../../src/domain/graph/extract.js';
import { insertEntityAt } from '../_helpers/graph-seed.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/host/config-file.js';
import { deleteEntry, loadEntities } from '../_helpers/root-forms.js';
import { saveDecision, savePolicy } from '../../src/entry/testing.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore, objectsAt } = sessionPerTest();

const T = 'default';

function addMemory(home: string, kind: 'distilled' | 'superseded' | 'raw'): string {
  const mem = createMemory('graph e2-provenance test memory', {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    tags: [],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'test',
    tenantId: T,
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

type EntityRow = {
  id: number;
  name: string;
  memory_id: string | null;
  source_object_type: string | null;
  source_object_id: number | null;
};

type RelationRow = {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  rel_type: string;
  memory_id: string | null;
  source_object_type: string | null;
  source_object_id: number | null;
};

function entityRows(home: string): EntityRow[] {
  const db = openHippoDb(home);
  try {
    // SAFETY: db.prepare().all() is typed `unknown[]` (node:sqlite has no
    // generic overload); the SELECT column list above matches EntityRow
    // field-for-field.
    return db
      .prepare(`SELECT id, name, memory_id, source_object_type, source_object_id FROM entities ORDER BY id`)
      .all() as EntityRow[];
  } finally {
    closeHippoDb(db);
  }
}

function relationRows(home: string): RelationRow[] {
  const db = openHippoDb(home);
  try {
    // SAFETY: db.prepare().all() is typed `unknown[]` (node:sqlite has no
    // generic overload); the SELECT column list above matches RelationRow
    // field-for-field.
    return db
      .prepare(
        `SELECT id, from_entity_id, to_entity_id, rel_type, memory_id, source_object_type, source_object_id FROM relations ORDER BY id`,
      )
      .all() as RelationRow[];
  } finally {
    closeHippoDb(db);
  }
}

describe('graph provenance is anchored to the first-class object, not its memory mirror', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('graph-e2-prov');
  });

  it('extract: a policy + a decision that mentions it produce entities + a references arc', async () => {
    const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Data Retention Policy',
      policyText: 'Delete logs after 90 days',
    });
    const decision = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt the Data Retention Policy for all log pipelines',
    });

    const r = await extractGraph(sqliteStore(home), T);
    expect(r.entities).toBe(2);
    expect(r.references).toBe(1);

    const ents = entityRows(home);
    expect(ents.length).toBe(2);
    const policyEnt = ents.find((e) => e.source_object_type === 'policy')!;
    const decisionEnt = ents.find((e) => e.source_object_type === 'decision')!;
    expect(policyEnt.source_object_id).toBe(policy.id);
    expect(decisionEnt.source_object_id).toBe(decision.id);
    expect(policyEnt.memory_id).not.toBeNull();
    expect(decisionEnt.memory_id).not.toBeNull();

    const rels = relationRows(home);
    expect(rels.length).toBe(1);
    expect(rels[0].rel_type).toBe('references');
    expect(rels[0].from_entity_id).toBe(decisionEnt.id);
    expect(rels[0].to_entity_id).toBe(policyEnt.id);
    expect(rels[0].source_object_type).toBe('decision');
    expect(rels[0].source_object_id).toBe(decision.id);
  });

  it('SUCCESS CRITERION: forget the decision mirror -> the active decision STAYS in the entities table (memory_id NULL, source_object set); its references arc preserved', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Data Retention Policy',
      policyText: 'Delete logs after 90 days',
    });
    const decision = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt the Data Retention Policy for all log pipelines',
    });

    deleteEntry(home, decision.memoryId!);

    const r = await extractGraph(sqliteStore(home), T);
    expect(r.entities).toBe(2);
    expect(r.references).toBe(1);

    const ents = entityRows(home);
    const decisionEnt = ents.find((e) => e.source_object_type === 'decision')!;
    expect(decisionEnt.memory_id).toBeNull();
    expect(decisionEnt.source_object_id).toBe(decision.id);

    const policyEnt = ents.find((e) => e.source_object_type === 'policy')!;
    expect(policyEnt.memory_id).not.toBeNull();

    const rels = relationRows(home);
    expect(rels.length).toBe(1);
    expect(rels[0].rel_type).toBe('references');
    expect(rels[0].from_entity_id).toBe(decisionEnt.id);
    expect(rels[0].memory_id).toBeNull();
    expect(rels[0].source_object_type).toBe('decision');
    expect(rels[0].source_object_id).toBe(decision.id);

    const apiEnt = loadEntities(home, T, { limit: 100 }).find((e) => e.sourceObjectType === 'decision')!;
    expect(apiEnt.memoryId).toBeNull();
    expect(apiEnt.sourceObjectId).toBe(decision.id);
  });

  it('a closed E2 object is excluded from the graph (status, not mirror presence, drives exclusion)', async () => {
    const keep = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Keep this active decision',
    });
    const gone = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Retire this one',
    });
    await closeObject(objectsAt(home), DECISION, { tenantId: T, id: gone.id, actor: CLI_ACTOR, now: evalNow() });

    await extractGraph(sqliteStore(home), T);
    const ents = entityRows(home);
    expect(ents.length).toBe(1);
    expect(ents[0].source_object_id).toBe(keep.id);
    expect(ents.some((e) => e.source_object_id === gone.id)).toBe(false);
  });

  it('the no-raw invariant holds: inserting an entity that references a raw memory still ABORTs', () => {
    const raw = addMemory(home, 'raw');
    expect(() => insertEntityAt(home, T, { entityType: 'system', name: 'x', memoryId: raw })).toThrow(
      /raw|consolidated/i,
    );
    const db = openHippoDb(home);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, created_at)
         VALUES (?, 'system', 'x', ?, 'distilled', ?)`,
          )
          .run(T, raw, new Date().toISOString()),
      ).toThrow(/source_kind must equal|raw|consolidated/i);
    } finally {
      closeHippoDb(db);
    }
  });

  it('the all-null guard: inserting an entity with neither memory nor source_object ABORTs', () => {
    expect(() => insertEntityAt(home, T, { entityType: 'system', name: 'x' })).toThrow(
      /needs a memory or a source object/i,
    );
    const db = openHippoDb(home);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'system', 'x', NULL, 'distilled', NULL, NULL, ?)`,
          )
          .run(T, new Date().toISOString()),
      ).toThrow(/needs a memory or a (complete )?source object/i);
    } finally {
      closeHippoDb(db);
    }
  });

  it('guard: memory NULL + source_object_id set + source_object_type NULL ABORTs (incomplete object provenance)', () => {
    const db = openHippoDb(home);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'decision', 'x', NULL, 'distilled', NULL, 7, ?)`,
          )
          .run(T, new Date().toISOString()),
      ).toThrow(/set together|all-or-none/i);
    } finally {
      closeHippoDb(db);
    }
  });

  it('object-path guard: inserting an entity pointing at a non-existent / wrong-tenant E2 row ABORTs', () => {
    expect(() =>
      insertEntityAt(home, T, { entityType: 'decision', name: 'ghost', sourceObject: { type: 'decision', id: 99999 } }),
    ).toThrow(/not found|active\/superseded|active|superseded/i);
    const db = openHippoDb(home);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'decision', 'ghost', NULL, 'distilled', 'decision', 99999, ?)`,
          )
          .run(T, new Date().toISOString()),
      ).toThrow(/source_object must reference|active|superseded/i);
    } finally {
      closeHippoDb(db);
    }
  });

  it('mirror forget on a memory-only entity deletes it with the memory', () => {
    const md = addMemory(home, 'distilled');
    const e = insertEntityAt(home, T, { entityType: 'system', name: 'mem-only', memoryId: md });
    expect(() => deleteEntry(home, md)).not.toThrow();
    expect(entityRows(home).find((r) => r.id === e.id)).toBeUndefined();
  });

  it('supersedes + references edges survive a mirror forget on an endpoint', async () => {
    const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Data Retention Policy',
      policyText: 'Delete logs after 90 days',
    });
    const v1 = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Access Control Policy',
      policyText: 'least privilege v1',
    });
    const v2 = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Access Control Policy',
      policyText: 'least privilege v2',
      supersedesPolicyId: v1.id,
    });
    const decision = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt the Data Retention Policy across all services',
    });

    deleteEntry(home, v2.memoryId!);
    deleteEntry(home, decision.memoryId!);

    await extractGraph(sqliteStore(home), T);
    const rels = relationRows(home);
    const sup = rels.find((r) => r.rel_type === 'supersedes')!;
    const ref = rels.find((r) => r.rel_type === 'references')!;

    expect(sup.memory_id).toBeNull();
    expect(sup.source_object_type).toBe('policy');
    expect(sup.source_object_id).toBe(v2.id);

    expect(ref.memory_id).toBeNull();
    expect(ref.source_object_type).toBe('decision');
    expect(ref.source_object_id).toBe(decision.id);

    const policyEnt = entityRows(home).find(
      (e) => e.source_object_id === policy.id && e.source_object_type === 'policy',
    )!;
    expect(policyEnt.memory_id).not.toBeNull();
  });

  it('a VALID memory + a BAD source_object is REJECTED (object validated even when memory present)', () => {
    const md = addMemory(home, 'distilled');
    expect(() =>
      insertEntityAt(home, T, {
        entityType: 'decision',
        name: 'x',
        memoryId: md,
        sourceObject: { type: 'decision', id: 99999 },
      }),
    ).toThrow(/not found|active|superseded/i);

    const md2 = addMemory(home, 'distilled');
    const db = openHippoDb(home);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO entities(tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at)
         VALUES (?, 'decision', 'x', ?, 'distilled', 'decision', 99999, ?)`,
          )
          .run(T, md2, new Date().toISOString()),
      ).toThrow(/source_object must reference|active|superseded/i);
    } finally {
      closeHippoDb(db);
    }
  });

  it('a stale-missing mirror is tolerated when a valid object is present (rebuild not rolled back)', async () => {
    const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Retention',
      policyText: 'p',
    });
    const ent = insertEntityAt(home, T, {
      entityType: 'policy',
      name: 'Retention',
      memoryId: 'sem_doesnotexist',
      sourceObject: { type: 'policy', id: policy.id },
    });
    expect(ent.memoryId).toBeNull();
    expect(ent.sourceObjectId).toBe(policy.id);
    expect(() => insertEntityAt(home, T, { entityType: 'system', name: 'x', memoryId: 'sem_doesnotexist' })).toThrow(
      /not found/i,
    );
  });

  it('an explicit UPDATE re-pointing a row to a bad object ABORTs (object cols changed); memory-only SET NULL still does not', async () => {
    await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Retention',
      policyText: 'p',
    });
    await extractGraph(sqliteStore(home), T);
    const polEnt = entityRows(home).find((e) => e.source_object_type === 'policy')!;
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`UPDATE entities SET source_object_id = 99999 WHERE id = ?`).run(polEnt.id)).toThrow(
        /source_object must reference|active|superseded/i,
      );
      expect(() => db.prepare(`UPDATE entities SET source_object_type = NULL WHERE id = ?`).run(polEnt.id)).toThrow(
        /set together|all-or-none/i,
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('a tenant-only move of an object-backed (mirrorless) row revalidates the object and ABORTs', async () => {
    const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Retention',
      policyText: 'p',
    });
    const ent = insertEntityAt(home, T, {
      entityType: 'policy',
      name: 'Retention',
      sourceObject: { type: 'policy', id: policy.id },
    });
    expect(ent.memoryId).toBeNull();
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`UPDATE entities SET tenant_id = 'other-tenant' WHERE id = ?`).run(ent.id)).toThrow(
        /source_object must reference|active|superseded/i,
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('close lifecycle: closing a MIRRORLESS object removes its graph rows directly (no rebuild)', async () => {
    const policy = await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      policyName: 'Data Retention Policy',
      policyText: 'Delete logs after 90 days',
    });
    const decision = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt the Data Retention Policy widely',
    });
    deleteEntry(home, decision.memoryId!);
    await extractGraph(sqliteStore(home), T);
    expect(
      entityRows(home).some((e) => e.source_object_type === 'decision' && e.source_object_id === decision.id),
    ).toBe(true);
    expect(relationRows(home).length).toBe(1);
    await closeObject(objectsAt(home), DECISION, { tenantId: T, id: decision.id, actor: CLI_ACTOR, now: evalNow() });

    expect(
      entityRows(home).some((e) => e.source_object_type === 'decision' && e.source_object_id === decision.id),
    ).toBe(false);
    expect(
      relationRows(home).some((r) => r.source_object_type === 'decision' && r.source_object_id === decision.id),
    ).toBe(false);
    expect(entityRows(home).some((e) => e.source_object_type === 'policy' && e.source_object_id === policy.id)).toBe(
      true,
    );
  });

  it('forgetting the mirror of a CLOSED-but-not-yet-rebuilt object does NOT block the delete (core sleep/forget safe)', async () => {
    const decision = await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, T, {
      decisionText: 'Adopt the retention rule for logs',
    });
    await extractGraph(sqliteStore(home), T);
    expect(entityRows(home).length).toBe(1);
    await closeObject(objectsAt(home), DECISION, { tenantId: T, id: decision.id, actor: CLI_ACTOR, now: evalNow() });
    expect(entityRows(home).length).toBe(0);
    expect(deleteEntry(home, decision.memoryId!)).toBe(true);
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT id FROM memories WHERE id = ?`).get(decision.memoryId!)).toBeUndefined();
      expect(db.prepare(`SELECT memory_id, status FROM decisions WHERE id = ?`).get(decision.id)).toEqual({
        memory_id: null,
        status: 'closed',
      });
    } finally {
      closeHippoDb(db);
    }
  });
});
