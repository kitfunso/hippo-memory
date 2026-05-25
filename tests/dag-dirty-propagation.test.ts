/**
 * v0.30 / E2 of DAG live-coupling — child-write dirty-flag propagation tests.
 *
 * Locks: 4 hook insertion sites fire on child mutation when parent is a
 * level-2 summary, early-exit on dag_parent_id IS NULL, cross-tenant safety,
 * idempotency across N child writes, orphan-child no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initStore,
  writeEntry,
  loadDirtySummaries,
  deleteEntry,
} from '../src/store.js';
import { openHippoDb } from '../src/db.js';
import { createMemory, Layer } from '../src/memory.js';
import { archiveRawMemory } from '../src/raw-archive.js';
import { invalidateMatching } from '../src/invalidation.js';
import { supersede } from '../src/api.js';
import type { Context } from '../src/context.js';

function defaultCtx(hippoRoot: string): Context {
  return {
    hippoRoot,
    tenantId: 'default',
    actor: { subject: 'test-actor', role: 'admin' },
  } as Context;
}

describe('v0.30 / E2 — child-write dirty-flag propagation', () => {
  let hippoRoot: string;
  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-e2-'));
    initStore(hippoRoot);
  });
  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('test #1: invalidateMatching → writeEntry on fact with dag_parent_id → parent marked dirty', () => {
    // Setup: summary + child fact whose content matches an invalidation target.
    const summary = createMemory('python deployment runbook', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    const fact = createMemory('use FRED cache for tips_10y series', {
      layer: Layer.Episodic,
      dag_level: 1,
      dag_parent_id: summary.id,
      tags: ['fred', 'cache'],
    });
    writeEntry(hippoRoot, fact);
    // Parent must NOT be dirty yet (the child writeEntry above DID mark dirty,
    // so first clear: re-read dirty list to confirm and reset for the
    // invalidation-specific assertion).
    const initialDirty = loadDirtySummaries(hippoRoot, 'default');
    expect(initialDirty.map((m) => m.id)).toContain(summary.id);
    // Clear the flag manually to isolate invalidation's effect.
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    db.close();
    // Act: invalidateMatching writes the fact back through writeEntry (L97).
    invalidateMatching(hippoRoot, { from: 'FRED cache' }, 'default');
    // Assert: parent dirty again.
    expect(loadDirtySummaries(hippoRoot, 'default').map((m) => m.id)).toContain(summary.id);
  });

  it('test #2: supersede with dag_parent_id → OLD parent marked dirty + NEW parent marked dirty (same parent, idempotent)', () => {
    const summary = createMemory('test summary 2', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    const oldFact = createMemory('old fact', {
      layer: Layer.Episodic,
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    writeEntry(hippoRoot, oldFact);
    // Clear initial dirty flag from the writeEntry above.
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    // Count audit rows BEFORE supersede so we can assert delta (1) not total.
    const beforeCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`,
    ).get(summary.id) as { n: number }).n;
    db.close();
    // Act: supersede the old fact. createMemory inside supersede passes
    // layer/tags/pinned/source/confidence/tenantId but NOT dag_parent_id,
    // so NEW has dag_parent_id=null and S1 hook early-exits for NEW. Only
    // S2 fires for OLD's parent → +1 audit row, parent dirty.
    supersede(defaultCtx(hippoRoot), oldFact.id, 'new corrected fact');
    expect(loadDirtySummaries(hippoRoot, 'default').map((m) => m.id)).toContain(summary.id);
    const db2 = openHippoDb(hippoRoot);
    const afterCount = (db2.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`,
    ).get(summary.id) as { n: number }).n;
    db2.close();
    expect(afterCount - beforeCount).toBe(1); // exactly 1 new transition 0→1 from supersede
  });

  it('test #3: deleteEntry on fact with dag_parent_id → parent marked dirty', () => {
    const summary = createMemory('test summary 3', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    const fact = createMemory('to be deleted', {
      layer: Layer.Episodic,
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    writeEntry(hippoRoot, fact);
    // Clear initial flag.
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    db.close();
    // Act: delete the fact.
    expect(deleteEntry(hippoRoot, fact.id, { actor: 'test' })).toBe(true);
    // Assert: parent dirty again.
    expect(loadDirtySummaries(hippoRoot, 'default').map((m) => m.id)).toContain(summary.id);
  });

  it('test #4: archiveRawMemory on raw row with dag_parent_id → parent marked dirty', () => {
    const summary = createMemory('test summary 4', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    const rawChild = createMemory('raw child to archive', {
      layer: Layer.Buffer,
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    // Force kind='raw' since createMemory defaults to 'distilled'.
    writeEntry(hippoRoot, rawChild);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET kind = 'raw' WHERE id = ?`).run(rawChild.id);
    db.prepare(`UPDATE memories SET summary_dirty = 0 WHERE id = ?`).run(summary.id);
    // Act: archive (inside our own savepoint not needed — archiveRawMemory has its own).
    archiveRawMemory(db, rawChild.id, { reason: 'test-archive', who: 'test-actor' });
    db.close();
    // Assert.
    expect(loadDirtySummaries(hippoRoot, 'default').map((m) => m.id)).toContain(summary.id);
  });

  it('test #5: writeEntry on fact WITHOUT dag_parent_id → no parent dirty-mark (early-exit verified)', () => {
    const orphan = createMemory('no parent fact', { layer: Layer.Episodic, dag_level: 1 });
    writeEntry(hippoRoot, orphan); // dag_parent_id defaults to null
    expect(loadDirtySummaries(hippoRoot, 'default')).toEqual([]);
  });

  it('test #6: cross-tenant safety — child tenant mismatched with parent tenant → no dirty-mark', () => {
    const summary = createMemory('tenant1 summary', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    // Manually move summary to tenant1.
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET tenant_id = 'tenant1' WHERE id = ?`).run(summary.id);
    db.close();
    // Write a child as default tenant whose dag_parent_id points to tenant1's summary.
    const child = createMemory('default-tenant child', {
      layer: Layer.Episodic,
      dag_level: 1,
      dag_parent_id: summary.id, // points across tenant boundary
    });
    writeEntry(hippoRoot, child);
    // Assert: tenant1 sees no dirty (the writeEntry hook called with child's
    // tenant_id='default', and markSummaryDirtyInTx WHERE tenant_id='default'
    // AND dag_level=2 matches 0 rows — summary belongs to tenant1).
    expect(loadDirtySummaries(hippoRoot, 'tenant1')).toEqual([]);
    expect(loadDirtySummaries(hippoRoot, 'default')).toEqual([]);
    // No audit row written either.
    const db2 = openHippoDb(hippoRoot);
    const auditRows = db2.prepare(
      `SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`,
    ).all(summary.id);
    db2.close();
    expect(auditRows).toEqual([]);
  });

  it('test #7: idempotency — 5 child writes under same parent → 1 audit row + parent stays dirty', () => {
    const summary = createMemory('summary 7', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    // Write 5 children under the same parent.
    for (let i = 0; i < 5; i++) {
      const child = createMemory(`child ${i}`, {
        layer: Layer.Episodic,
        dag_level: 1,
        dag_parent_id: summary.id,
      });
      writeEntry(hippoRoot, child);
    }
    // Assert: exactly 1 audit row for the 0→1 transition; parent stays dirty=1.
    const db = openHippoDb(hippoRoot);
    const auditRows = db.prepare(
      `SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`,
    ).all(summary.id);
    const row = db.prepare(`SELECT summary_dirty FROM memories WHERE id = ?`).get(summary.id) as {
      summary_dirty: number;
    };
    db.close();
    expect(auditRows).toHaveLength(1);
    expect(row.summary_dirty).toBe(1);
  });

  it('test #8: orphan child (parent deleted) → markSummaryDirtyInTx no-ops, no exception', () => {
    const summary = createMemory('to be deleted parent', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    // Delete the summary. Now the parent id is dangling.
    deleteEntry(hippoRoot, summary.id, { actor: 'test' });
    // Write a child pointing at the now-gone parent.
    const orphan = createMemory('orphan child', {
      layer: Layer.Episodic,
      dag_level: 1,
      dag_parent_id: summary.id, // points to deleted parent
    });
    // Must not throw.
    expect(() => writeEntry(hippoRoot, orphan)).not.toThrow();
    // No dirty rows (parent gone), no audit row for the missing parent
    // (markSummaryDirtyInTx WHERE id=? matched 0 rows).
    expect(loadDirtySummaries(hippoRoot, 'default')).toEqual([]);
  });
});
