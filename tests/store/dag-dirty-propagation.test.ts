import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { archiveRawMemory } from '../../src/store/sqlite/entries/raw-archive.js';
import { invalidateMatching } from '../../src/domain/learn/invalidation.js';
import { supersede } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { deleteEntry, loadAllDirtySummaries, batchWriteAndDeleteInFolder } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore, apiCtx } = sessionPerTest();

function defaultCtx(hippoRoot: string): FullContext {
  return apiCtx(hippoRoot, 'default', { subject: 'test-actor', role: 'admin' });
}

async function dirtyFor(root: string, tenantId: string): Promise<MemoryEntry[]> {
  return (await loadAllDirtySummaries(root)).filter((m) => m.tenantId === tenantId);
}

describe('child-write dirty-flag propagation', () => {
  let hippoRoot: string;
  beforeEach(() => {
    hippoRoot = makeRoot('dag-e2');
  });

  it('invalidateMatching → writeEntry on fact with dag_parent_id → parent marked dirty', async () => {
    const summary = createMemory('python deployment runbook', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const fact = createMemory('use FRED cache for tips_10y series', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      dagParentId: summary.id,
      tags: ['fred', 'cache'],
    });
    writeEntry(hippoRoot, fact);
    const initialDirty = await dirtyFor(hippoRoot, 'default');
    expect(initialDirty.map((m) => m.id)).toContain(summary.id);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    closeHippoDb(db);
    await invalidateMatching(sqliteStore(hippoRoot), { from: 'FRED cache', to: null, type: 'removal' }, 'default');
    expect((await dirtyFor(hippoRoot, 'default')).map((m) => m.id)).toContain(summary.id);
  });

  it('supersede with dag_parent_id → OLD parent marked dirty + NEW parent marked dirty (same parent, idempotent)', async () => {
    const summary = createMemory('test summary 2', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const oldFact = createMemory('old fact', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      dagParentId: summary.id,
    });
    writeEntry(hippoRoot, oldFact);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    // SAFETY: `SELECT COUNT(*) AS n` always returns exactly one row shaped { n: number }.
    const beforeCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`)
        .get(summary.id) as { n: number }
    ).n;
    closeHippoDb(db);
    await supersede(defaultCtx(hippoRoot), oldFact.id, 'new corrected fact');
    expect((await dirtyFor(hippoRoot, 'default')).map((m) => m.id)).toContain(summary.id);
    const db2 = openHippoDb(hippoRoot);
    // SAFETY: `SELECT COUNT(*) AS n` always returns exactly one row shaped { n: number }.
    const afterCount = (
      db2
        .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`)
        .get(summary.id) as { n: number }
    ).n;
    closeHippoDb(db2);
    expect(afterCount - beforeCount).toBe(1);
  });

  it('deleteEntry on fact with dag_parent_id → parent marked dirty', async () => {
    const summary = createMemory('test summary 3', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const fact = createMemory('to be deleted', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      dagParentId: summary.id,
    });
    writeEntry(hippoRoot, fact);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    closeHippoDb(db);
    expect(deleteEntry(hippoRoot, fact.id, { actor: 'test' })).toBe(true);
    expect((await dirtyFor(hippoRoot, 'default')).map((m) => m.id)).toContain(summary.id);
  });

  it('archiveRawMemory on raw row with dag_parent_id → parent marked dirty', async () => {
    const summary = createMemory('test summary 4', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const rawChild = createMemory('raw child to archive', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Buffer,
      dagLevel: 1,
      dagParentId: summary.id,
    });
    writeEntry(hippoRoot, rawChild);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET kind = 'raw' WHERE id = ?`).run(rawChild.id);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    archiveRawMemory(db, rawChild.id, { reason: 'test-archive', who: 'test-actor' });
    closeHippoDb(db);
    expect((await dirtyFor(hippoRoot, 'default')).map((m) => m.id)).toContain(summary.id);
  });

  it('writeEntry on fact WITHOUT dag_parent_id → no parent dirty-mark (early-exit verified)', async () => {
    const orphan = createMemory('no parent fact', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
    });
    writeEntry(hippoRoot, orphan);
    expect(await dirtyFor(hippoRoot, 'default')).toEqual([]);
  });

  it('cross-tenant safety: child tenant mismatched with parent tenant → no dirty-mark', async () => {
    const summary = createMemory('tenant1 summary', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET tenant_id = 'tenant1' WHERE id = ?`).run(summary.id);
    closeHippoDb(db);
    const child = createMemory('default-tenant child', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      dagParentId: summary.id, // points across tenant boundary
    });
    writeEntry(hippoRoot, child);
    expect(await dirtyFor(hippoRoot, 'tenant1')).toEqual([]);
    expect(await dirtyFor(hippoRoot, 'default')).toEqual([]);
    const db2 = openHippoDb(hippoRoot);
    const auditRows = db2
      .prepare(`SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`)
      .all(summary.id);
    closeHippoDb(db2);
    expect(auditRows).toEqual([]);
  });

  it('idempotency: 5 child writes under same parent → 1 audit row + parent stays dirty', () => {
    const summary = createMemory('summary 7', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    for (let i = 0; i < 5; i++) {
      const child = createMemory(`child ${i}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Episodic,
        dagLevel: 1,
        dagParentId: summary.id,
      });
      writeEntry(hippoRoot, child);
    }
    const db = openHippoDb(hippoRoot);
    const auditRows = db
      .prepare(`SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`)
      .all(summary.id);
    // SAFETY: `summary` was just written via writeEntry above, so the row for
    // its id exists and always has a summary_dirty column value.
    const row = db.prepare(`SELECT summary_dirty FROM memories WHERE id = ?`).get(summary.id) as {
      summary_dirty: number;
    };
    closeHippoDb(db);
    expect(auditRows).toHaveLength(1);
    expect(row.summary_dirty).toBe(1);
  });

  it('batchWriteAndDelete marks parents dirty for writes AND deletes', async () => {
    const summary = createMemory('batch test summary', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const db0 = openHippoDb(hippoRoot);
    db0.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    closeHippoDb(db0);

    const childToDelete = createMemory('child to delete', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      dagParentId: summary.id,
    });
    writeEntry(hippoRoot, childToDelete);
    const db1 = openHippoDb(hippoRoot);
    db1.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    closeHippoDb(db1);

    const newBatchChild = createMemory('batch child', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      dagParentId: summary.id,
    });
    batchWriteAndDeleteInFolder(hippoRoot, [newBatchChild], [childToDelete.id]);

    expect((await dirtyFor(hippoRoot, 'default')).map((m) => m.id)).toContain(summary.id);
    const db2 = openHippoDb(hippoRoot);
    const auditRows = db2
      .prepare(`SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`)
      .all(summary.id);
    closeHippoDb(db2);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it('orphan child (parent deleted) → markSummaryDirtyInTx no-ops, no exception', async () => {
    const summary = createMemory('to be deleted parent', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    deleteEntry(hippoRoot, summary.id, { actor: 'test' });
    const orphan = createMemory('orphan child', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      dagLevel: 1,
      dagParentId: summary.id, // points to deleted parent
    });
    expect(() => writeEntry(hippoRoot, orphan)).not.toThrow();
    expect(await dirtyFor(hippoRoot, 'default')).toEqual([]);
  });
});
