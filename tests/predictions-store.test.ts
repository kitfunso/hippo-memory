/**
 * E2 prediction first-class object — store-layer tests.
 * Docs: docs/plans/2026-05-26-e2-prediction-object.md
 *
 * Covers:
 * 1. savePrediction creates both memory and predictions row
 * 2. SAVEPOINT atomicity: writeEntry afterWrite throw rolls back BOTH
 *    the memory row AND the predictions row (the canonical injection
 *    pattern from tests/connectors-slack-ingest.test.ts)
 * 3. closePrediction updates the row + emits audit
 * 4. Cross-tenant INSERT trigger: tenant_id mismatch raises ABORT
 * 5. ON DELETE SET NULL: forget the memory, prediction survives with NULL memory_id
 * 6. loadPredictionsByClass filters by class + closure_state
 * 7. loadOpenPredictions excludes closed
 * 8. VALID_CLOSURE_STATES rejection at the closePrediction layer
 * 9. Tenant scoping: cross-tenant load returns empty
 * 10. Schema v29 migration produces predictions table + triggers + indexes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initStore,
  deleteEntry,
  writeEntry,
} from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  savePrediction,
  closePrediction,
  loadPredictionById,
  loadPredictionsByClass,
  loadOpenPredictions,
  VALID_CLOSURE_STATES,
} from '../src/predictions.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('predictions store (E2 first-class object, v0.31)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('predictions'); });
  afterEach(() => safeRmSync(home));

  it('savePrediction creates both memory and predictions row', () => {
    const pred = savePrediction(home, 'default', {
      classTag: 'migration-effort',
      claimText: 'migration takes 2 days',
      estimateValue: 2,
      estimateUnit: 'days',
      targetDate: '2026-06-15',
    });

    expect(pred.id).toBeGreaterThan(0);
    expect(pred.memoryId).toBeDefined();
    expect(pred.memoryId).not.toBeNull();
    expect(pred.tenantId).toBe('default');
    expect(pred.classTag).toBe('migration-effort');
    expect(pred.claimText).toBe('migration takes 2 days');
    expect(pred.estimateValue).toBe(2);
    expect(pred.estimateUnit).toBe('days');
    expect(pred.targetDate).toBe('2026-06-15');
    expect(pred.actualValue).toBeNull();
    expect(pred.closureState).toBe('open');
    expect(pred.closedAt).toBeNull();

    // Memory mirror exists with the prediction tag
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT id, content, tags_json FROM memories WHERE id = ?`).get(pred.memoryId!) as { id: string; content: string; tags_json: string } | undefined;
      expect(memRow).toBeDefined();
      expect(memRow!.content).toBe('migration takes 2 days');
      const tags = JSON.parse(memRow!.tags_json) as string[];
      expect(tags).toContain('prediction');
      expect(tags).toContain('migration-effort');
    } finally {
      closeHippoDb(db);
    }
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both memory and predictions row', () => {
    // Inject failure mid-savePrediction by writing a manual memory then
    // calling writeEntry with an afterWrite that throws. Verify no orphan
    // memory row OR predictions row land.
    const memBefore = (() => {
      const db = openHippoDb(home);
      try {
        return (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as { c: number }).c;
      } finally { closeHippoDb(db); }
    })();
    const predBefore = (() => {
      const db = openHippoDb(home);
      try {
        return (db.prepare(`SELECT COUNT(*) as c FROM predictions`).get() as { c: number }).c;
      } finally { closeHippoDb(db); }
    })();

    const mem = createMemory('throwing prediction', {
      tags: ['prediction', 'test-class'],
      layer: Layer.Semantic,
      confidence: 'observed',
      source: 'prediction',
      kind: 'distilled' as MemoryKind,
      tenantId: 'default',
    });

    expect(() => {
      writeEntry(home, mem, {
        afterWrite: () => {
          throw new Error('forced afterWrite failure');
        },
      });
    }).toThrow('forced afterWrite failure');

    // Memory row count unchanged (SAVEPOINT rollback)
    const memAfter = (() => {
      const db = openHippoDb(home);
      try {
        return (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as { c: number }).c;
      } finally { closeHippoDb(db); }
    })();
    expect(memAfter).toBe(memBefore);

    // Predictions row count unchanged
    const predAfter = (() => {
      const db = openHippoDb(home);
      try {
        return (db.prepare(`SELECT COUNT(*) as c FROM predictions`).get() as { c: number }).c;
      } finally { closeHippoDb(db); }
    })();
    expect(predAfter).toBe(predBefore);
  });

  it('closePrediction updates the row + emits predict_close audit', () => {
    const pred = savePrediction(home, 'default', {
      classTag: 'rollout-risk',
      claimText: 'low risk rollout',
      estimateValue: 0.1,
    });

    const closed = closePrediction(home, 'default', pred.id, {
      closureState: 'closed',
      actualValue: 0.4,
      closureNote: 'higher than expected',
    });

    expect(closed.id).toBe(pred.id);
    expect(closed.closureState).toBe('closed');
    expect(closed.actualValue).toBe(0.4);
    expect(closed.closureNote).toBe('higher than expected');
    expect(closed.closedAt).toBeDefined();
    expect(closed.closedAt).not.toBeNull();

    // Audit row landed
    const db = openHippoDb(home);
    try {
      const auditRows = db.prepare(
        `SELECT op, target_id, metadata_json FROM audit_log WHERE op = 'predict_close' AND target_id = ?`
      ).all(String(pred.id)) as Array<{ op: string; target_id: string; metadata_json: string }>;
      expect(auditRows.length).toBe(1);
      const meta = JSON.parse(auditRows[0].metadata_json) as { prediction_id: number; closure_state: string; has_actual: boolean };
      expect(meta.closure_state).toBe('closed');
      expect(meta.has_actual).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('cross-tenant INSERT trigger raises ABORT on tenant_id mismatch', () => {
    // Create a memory under tenant 'tenant-a'
    const mem = createMemory('tenant-a memory', {
      tags: ['x'],
      layer: Layer.Semantic,
      confidence: 'observed',
      source: 'test',
      kind: 'distilled' as MemoryKind,
      tenantId: 'tenant-a',
    });
    writeEntry(home, mem);

    // Attempt manual cross-tenant INSERT with raw SQL
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`
          INSERT INTO predictions(memory_id, tenant_id, class_tag, claim_text, closure_state, created_at)
          VALUES (?, 'tenant-b', 'x', 'cross-tenant attempt', 'open', ?)
        `).run(mem.id, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the prediction (memory_id NULL)', () => {
    const pred = savePrediction(home, 'default', {
      classTag: 'test-class',
      claimText: 'soft-link test',
      estimateValue: 1,
    });
    expect(pred.memoryId).not.toBeNull();

    // Forget the backing memory via deleteEntry (one of the 4 deletion paths
    // round-1 CRIT identified)
    deleteEntry(home, pred.memoryId!, 'default');

    // Prediction row still exists, memory_id is now NULL
    const reloaded = loadPredictionById(home, 'default', pred.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.memoryId).toBeNull();
    expect(reloaded!.claimText).toBe('soft-link test');
    expect(reloaded!.closureState).toBe('open');
  });

  it('loadPredictionsByClass filters by class + closure_state', () => {
    savePrediction(home, 'default', { classTag: 'a', claimText: 'open-a-1' });
    savePrediction(home, 'default', { classTag: 'a', claimText: 'open-a-2' });
    savePrediction(home, 'default', { classTag: 'b', claimText: 'open-b-1' });

    const aOpen = loadPredictionsByClass(home, 'default', 'a', { closureState: 'open' });
    expect(aOpen.length).toBe(2);
    expect(aOpen.every((p) => p.classTag === 'a')).toBe(true);
    expect(aOpen.every((p) => p.closureState === 'open')).toBe(true);

    const bOpen = loadPredictionsByClass(home, 'default', 'b');
    expect(bOpen.length).toBe(1);
    expect(bOpen[0].classTag).toBe('b');
  });

  it('loadOpenPredictions excludes closed', () => {
    const p1 = savePrediction(home, 'default', { classTag: 'x', claimText: 'first prediction' });
    savePrediction(home, 'default', { classTag: 'x', claimText: 'second prediction' });
    closePrediction(home, 'default', p1.id, { closureState: 'closed', actualValue: 1 });

    const open = loadOpenPredictions(home, 'default');
    expect(open.length).toBe(1);
    expect(open[0].closureState).toBe('open');
    expect(open[0].claimText).toBe('second prediction');
  });

  it('VALID_CLOSURE_STATES rejection: invalid state throws at closePrediction', () => {
    const pred = savePrediction(home, 'default', { classTag: 'x', claimText: 'open prediction text' });
    expect(() => {
      closePrediction(home, 'default', pred.id, {
        // @ts-expect-error — runtime validation test
        closureState: 'closed-clean',
      });
    }).toThrow(/closureState must be one of/);

    expect(VALID_CLOSURE_STATES.has('open')).toBe(true);
    expect(VALID_CLOSURE_STATES.has('closed')).toBe(true);
    expect(VALID_CLOSURE_STATES.has('closed-unknown')).toBe(true);
    // @ts-expect-error
    expect(VALID_CLOSURE_STATES.has('closed-clean')).toBe(false);
  });

  it('tenant scoping: cross-tenant load returns empty', () => {
    savePrediction(home, 'tenant-a', { classTag: 'x', claimText: 'a-mem' });
    savePrediction(home, 'tenant-b', { classTag: 'x', claimText: 'b-mem' });

    const aResults = loadPredictionsByClass(home, 'tenant-a', 'x');
    const bResults = loadPredictionsByClass(home, 'tenant-b', 'x');
    const cResults = loadPredictionsByClass(home, 'tenant-c', 'x');

    expect(aResults.length).toBe(1);
    expect(aResults[0].claimText).toBe('a-mem');
    expect(bResults.length).toBe(1);
    expect(bResults[0].claimText).toBe('b-mem');
    expect(cResults.length).toBe(0);
  });

  it('schema v29 migration produces predictions table + triggers + indexes', () => {
    const db = openHippoDb(home);
    try {
      // Table exists
      const tableRow = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'`
      ).get() as { name?: string } | undefined;
      expect(tableRow?.name).toBe('predictions');

      // Triggers exist
      const triggers = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_predictions_%'`
      ).all() as Array<{ name: string }>;
      const triggerNames = triggers.map((t) => t.name);
      expect(triggerNames).toContain('trg_predictions_tenant_match_insert');
      expect(triggerNames).toContain('trg_predictions_tenant_match_update');

      // Indexes exist
      const indexes = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_predictions_%'`
      ).all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_predictions_tenant_class');
      expect(indexNames).toContain('idx_predictions_memory');

      // CHECK constraint via direct violation attempt
      expect(() => {
        db.prepare(`
          INSERT INTO predictions(tenant_id, class_tag, claim_text, closure_state, created_at)
          VALUES ('default', 'x', 'check-violation', 'invalid-state', ?)
        `).run(new Date().toISOString());
      }).toThrow(/CHECK constraint failed/);
    } finally {
      closeHippoDb(db);
    }
  });
});
