import { describe, it, expect, beforeEach } from 'vitest';
import { markSummaryDirtyInTx } from '../../src/store/sqlite/entries/summary-dirty.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllDirtySummaries, writeEntry } from '../_helpers/root-forms.js';

async function dirtyFor(root: string, tenantId: string): Promise<MemoryEntry[]> {
  return (await loadAllDirtySummaries(root)).filter((m) => m.tenantId === tenantId);
}

function markDirty(root: string, summaryId: string, tenantId: string, actor: string): void {
  const db = openHippoDb(root);
  try {
    markSummaryDirtyInTx(db, { summaryId, tenantId, actor });
  } finally {
    closeHippoDb(db);
  }
}

describe('v28 schema migration + dirty-flag plumbing', () => {
  let hippoRoot: string;
  beforeEach(() => {
    hippoRoot = makeRoot('dag-e1');
  });

  it('migration v28 is idempotent: each column once, schema version unchanged, a written value survives a reopen', () => {
    const summary = createMemory('idempotency summary', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const columns = ['summary_dirty', 'last_rebuilt_at', 'rebuild_count', 'dag_level_3_built_at'];
    const inspect = () => {
      const db = openHippoDb(hippoRoot);
      try {
        // SAFETY: PRAGMA table_info returns one row per column, each with a string name.
        const info = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
        // SAFETY: PRAGMA user_version returns one row with that integer column.
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
        return {
          names: info.map((c) => c.name),
          version: version.user_version,
          row: db.prepare('SELECT summary_dirty, rebuild_count FROM memories WHERE id = ?').get(summary.id),
        };
      } finally {
        closeHippoDb(db);
      }
    };
    const first = inspect();
    const db = openHippoDb(hippoRoot);
    db.prepare('UPDATE memories SET summary_dirty = 1, rebuild_count = 7 WHERE id = ?').run(summary.id);
    closeHippoDb(db);
    const second = inspect();
    for (const column of columns) expect(second.names.filter((n) => n === column)).toHaveLength(1);
    expect(second.version).toBe(first.version);
    expect(first.row).toEqual({ summary_dirty: 0, rebuild_count: 0 });
    expect(second.row).toEqual({ summary_dirty: 1, rebuild_count: 7 });
  });

  it('backfill leaves rows clean (summary_dirty=0, rebuild_count=0, NULL timestamps)', () => {
    const summary = createMemory('test summary', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    const db = openHippoDb(hippoRoot);
    // SAFETY: the SELECT list above names exactly these four columns, so
    // every returned row has this shape.
    const row = db
      .prepare(`SELECT summary_dirty, last_rebuilt_at, rebuild_count, dag_level_3_built_at FROM memories WHERE id = ?`)
      .get(summary.id) as {
      summary_dirty: number;
      last_rebuilt_at: string | null;
      rebuild_count: number;
      dag_level_3_built_at: string | null;
    };
    closeHippoDb(db);
    expect(row.summary_dirty).toBe(0);
    expect(row.last_rebuilt_at).toBeNull();
    expect(row.rebuild_count).toBe(0);
    expect(row.dag_level_3_built_at).toBeNull();
  });

  it('markSummaryDirtyInTx + loadDirtySummaries round-trip per tenant (cross-tenant isolation)', async () => {
    const summaryA = createMemory('summary A', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    const summaryB = createMemory('summary B', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summaryA);
    writeEntry(hippoRoot, summaryB);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET tenant_id = ? WHERE id = ?`).run('tenant2', summaryB.id);
    closeHippoDb(db);
    markDirty(hippoRoot, summaryA.id, 'default', 'test-actor');
    expect((await dirtyFor(hippoRoot, 'default')).map((m) => m.id)).toEqual([summaryA.id]);
    expect((await dirtyFor(hippoRoot, 'tenant2')).map((m) => m.id)).toEqual([]);
  });

  it('markSummaryDirtyInTx is idempotent (second call writes no audit row + summary_dirty stays 1)', () => {
    const summary = createMemory('idempotent test', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    markDirty(hippoRoot, summary.id, 'default', 'actor');
    markDirty(hippoRoot, summary.id, 'default', 'actor');
    const db = openHippoDb(hippoRoot);
    const auditRows = db
      .prepare(`SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`)
      .all(summary.id);
    // SAFETY: `SELECT summary_dirty` names exactly this one numeric column.
    const row = db.prepare(`SELECT summary_dirty FROM memories WHERE id = ?`).get(summary.id) as {
      summary_dirty: number;
    };
    closeHippoDb(db);
    expect(auditRows).toHaveLength(1);
    expect(row.summary_dirty).toBe(1);
  });

  it('markSummaryDirtyInTx no-ops on non-summary rows (dag_level !== 2)', async () => {
    const leaf = createMemory('a leaf', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 1,
    });
    writeEntry(hippoRoot, leaf);
    markDirty(hippoRoot, leaf.id, 'default', 'actor');
    expect(await dirtyFor(hippoRoot, 'default')).toEqual([]);
    const db = openHippoDb(hippoRoot);
    const auditRows = db.prepare(`SELECT * FROM audit_log WHERE op = 'summary_marked_dirty'`).all();
    closeHippoDb(db);
    expect(auditRows).toEqual([]);
  });

  it('markSummaryDirtyInTx no-ops on unknown id', async () => {
    markDirty(hippoRoot, 'sem_does_not_exist', 'default', 'actor');
    expect(await dirtyFor(hippoRoot, 'default')).toEqual([]);
    const db = openHippoDb(hippoRoot);
    const auditRows = db.prepare(`SELECT * FROM audit_log WHERE op = 'summary_marked_dirty'`).all();
    closeHippoDb(db);
    expect(auditRows).toEqual([]);
  });

  it('markSummaryDirtyInTx rejects cross-tenant attack write (locks WHERE tenant_id=? guard against future regression)', async () => {
    const summaryB = createMemory('cross-tenant target', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summaryB);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET tenant_id = ? WHERE id = ?`).run('tenant2', summaryB.id);
    closeHippoDb(db);
    markDirty(hippoRoot, summaryB.id, 'default', 'attacker');
    expect(await dirtyFor(hippoRoot, 'tenant2')).toEqual([]);
    expect(await dirtyFor(hippoRoot, 'default')).toEqual([]);
    const db2 = openHippoDb(hippoRoot);
    const auditRows = db2
      .prepare(`SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`)
      .all(summaryB.id);
    closeHippoDb(db2);
    expect(auditRows).toEqual([]);
  });

  it('audit-query round-trip: markSummaryDirtyInTx + queryAuditEvents(op=summary_marked_dirty) returns the row', () => {
    const summary = createMemory('audit round-trip', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      dagLevel: 2,
    });
    writeEntry(hippoRoot, summary);
    markDirty(hippoRoot, summary.id, 'default', 'test-actor');
    const db = openHippoDb(hippoRoot);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'summary_marked_dirty' });
      expect(events).toHaveLength(1);
      expect(events[0]!.targetId).toBe(summary.id);
      expect(events[0]!.actor).toBe('test-actor');
      expect(events[0]!.metadata).toMatchObject({ dag_level: 2, source: 'E2' });
    } finally {
      closeHippoDb(db);
    }
  });
});
