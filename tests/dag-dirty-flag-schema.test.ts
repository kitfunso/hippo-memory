/**
 * v0.30 / E1 of DAG live-coupling — schema v28 + dirty-flag plumbing tests.
 *
 * Locks: migration idempotency, backfill cleanliness, markSummaryDirty +
 * loadDirtySummaries round-trip with tenant isolation, idempotent
 * dirty-marks (no second audit row), no-op on non-summary rows, no-op on
 * unknown id, and the audit-query round-trip that exercises the
 * VALID_AUDIT_OPS lockstep wiring (v1.11.5 CRIT A institutional rule).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initStore,
  writeEntry,
  loadDirtySummaries,
  markSummaryDirty,
} from '../src/store.js';
import { openHippoDb } from '../src/db.js';
import { createMemory, Layer } from '../src/memory.js';
import { queryAuditEvents } from '../src/audit.js';

describe('v28 schema migration + dirty-flag plumbing (E1)', () => {
  let hippoRoot: string;
  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-e1-'));
    initStore(hippoRoot);
  });
  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('migration v28 is idempotent (re-open does not error or duplicate columns)', () => {
    // initStore in beforeEach already ran v28. Re-open twice more and
    // confirm the 4 new columns are present + the migration runner
    // skips v28 on subsequent opens.
    const db1 = openHippoDb(hippoRoot);
    db1.close();
    const db2 = openHippoDb(hippoRoot);
    expect(() =>
      db2.prepare(
        `SELECT summary_dirty, last_rebuilt_at, rebuild_count, dag_level_3_built_at FROM memories`,
      ).all(),
    ).not.toThrow();
    db2.close();
  });

  it('backfill leaves rows clean (summary_dirty=0, rebuild_count=0, NULL timestamps)', () => {
    const summary = createMemory('test summary', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    const db = openHippoDb(hippoRoot);
    const row = db.prepare(
      `SELECT summary_dirty, last_rebuilt_at, rebuild_count, dag_level_3_built_at FROM memories WHERE id = ?`,
    ).get(summary.id) as {
      summary_dirty: number;
      last_rebuilt_at: string | null;
      rebuild_count: number;
      dag_level_3_built_at: string | null;
    };
    db.close();
    expect(row.summary_dirty).toBe(0);
    expect(row.last_rebuilt_at).toBeNull();
    expect(row.rebuild_count).toBe(0);
    expect(row.dag_level_3_built_at).toBeNull();
  });

  it('markSummaryDirty + loadDirtySummaries round-trip per tenant (cross-tenant isolation)', () => {
    // Seed 2 summaries in different tenants. createMemory defaults
    // tenantId to 'default'; manually rewrite the second to 'tenant2'
    // via SQL — keeps the test self-contained without env shenanigans.
    const summaryA = createMemory('summary A', { layer: Layer.Semantic, dag_level: 2 });
    const summaryB = createMemory('summary B', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summaryA);
    writeEntry(hippoRoot, summaryB);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET tenant_id = ? WHERE id = ?`).run('tenant2', summaryB.id);
    db.close();
    markSummaryDirty(hippoRoot, summaryA.id, 'default', 'test-actor');
    expect(loadDirtySummaries(hippoRoot, 'default').map((m) => m.id)).toEqual([summaryA.id]);
    expect(loadDirtySummaries(hippoRoot, 'tenant2').map((m) => m.id)).toEqual([]);
  });

  it('markSummaryDirty is idempotent (second call writes no audit row + summary_dirty stays 1)', () => {
    const summary = createMemory('idempotent test', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    markSummaryDirty(hippoRoot, summary.id, 'default', 'actor');
    markSummaryDirty(hippoRoot, summary.id, 'default', 'actor');
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

  it('markSummaryDirty no-ops on non-summary rows (dag_level !== 2)', () => {
    const leaf = createMemory('a leaf', { layer: Layer.Semantic, dag_level: 1 });
    writeEntry(hippoRoot, leaf);
    markSummaryDirty(hippoRoot, leaf.id, 'default', 'actor');
    expect(loadDirtySummaries(hippoRoot, 'default')).toEqual([]);
    const db = openHippoDb(hippoRoot);
    const auditRows = db.prepare(
      `SELECT * FROM audit_log WHERE op = 'summary_marked_dirty'`,
    ).all();
    db.close();
    expect(auditRows).toEqual([]);
  });

  it('markSummaryDirty no-ops on unknown id (R1 MED-3 test gap)', () => {
    markSummaryDirty(hippoRoot, 'sem_does_not_exist', 'default', 'actor');
    expect(loadDirtySummaries(hippoRoot, 'default')).toEqual([]);
    const db = openHippoDb(hippoRoot);
    const auditRows = db.prepare(
      `SELECT * FROM audit_log WHERE op = 'summary_marked_dirty'`,
    ).all();
    db.close();
    expect(auditRows).toEqual([]);
  });

  it('markSummaryDirty rejects cross-tenant attack write (locks WHERE tenant_id=? guard against future regression)', () => {
    // Write summaryB as tenant2, then attempt to mark it dirty as 'default'
    // tenant. WHERE id=? AND tenant_id=? guard should match 0 rows; no
    // audit row emitted; tenant2's loadDirtySummaries still returns empty.
    // Independent-review-critic MED: without this test, dropping the
    // tenant_id clause from markSummaryDirty's UPDATE would pass all
    // prior 7 cases.
    const summaryB = createMemory('cross-tenant target', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summaryB);
    const db = openHippoDb(hippoRoot);
    db.prepare(`UPDATE memories SET tenant_id = ? WHERE id = ?`).run('tenant2', summaryB.id);
    db.close();
    // Attack: mark dirty using the WRONG tenant.
    markSummaryDirty(hippoRoot, summaryB.id, 'default', 'attacker');
    // Verify: tenant2 still sees no dirty rows, no audit row written.
    expect(loadDirtySummaries(hippoRoot, 'tenant2')).toEqual([]);
    expect(loadDirtySummaries(hippoRoot, 'default')).toEqual([]);
    const db2 = openHippoDb(hippoRoot);
    const auditRows = db2.prepare(
      `SELECT * FROM audit_log WHERE op = 'summary_marked_dirty' AND target_id = ?`,
    ).all(summaryB.id);
    db2.close();
    expect(auditRows).toEqual([]);
  });

  it('audit-query round-trip: markSummaryDirty + queryAuditEvents(op=summary_marked_dirty) returns the row (R2 institutional VALID_AUDIT_OPS lockstep test)', () => {
    // Locks the v1.11.5 hardening pass institutional rule: a new AuditOp
    // is useless without VALID_AUDIT_OPS Set extensions in BOTH cli.ts +
    // server.ts. This test exercises the queryAuditEvents path that both
    // downstream sites consume.
    const summary = createMemory('audit round-trip', { layer: Layer.Semantic, dag_level: 2 });
    writeEntry(hippoRoot, summary);
    markSummaryDirty(hippoRoot, summary.id, 'default', 'test-actor');
    const db = openHippoDb(hippoRoot);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'summary_marked_dirty' });
      expect(events).toHaveLength(1);
      expect(events[0]!.targetId).toBe(summary.id);
      expect(events[0]!.actor).toBe('test-actor');
      expect(events[0]!.metadata).toMatchObject({ dag_level: 2, source: 'E1' });
    } finally {
      db.close();
    }
  });
});
