/**
 * J3.2 — emitAudit flag on computePredictionBaserate.
 *
 * The flag was added so the J3.2 orchestrator (computePlanningFallacyHint)
 * can call the baserate helper WITHOUT emitting a predict_baserate audit
 * row (the orchestrator emits its own recall_autodebias_hint row, with
 * n_closed + mean_ratio in metadata, so no telemetry is lost). This keeps
 * the predict_baserate audit channel scoped to deliberate CLI / HTTP /
 * MCP predict-baserate calls; without the flag, every recall containing
 * a forward-claim phrase would pollute the channel.
 *
 * This test locks both code paths in computePredictionBaserate:
 *   - n=0 (empty class) path at predictions.ts:447 region
 *   - n>0 (populated class) path at predictions.ts:490 region
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 2, Task 9).
 * Project rule: always use real DB for tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  computePredictionBaserate,
  savePrediction,
  closePrediction,
} from '../src/predictions.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function countPredictBaserateAudits(root: string): number {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = 'predict_baserate'`).get() as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

describe('computePredictionBaserate emitAudit flag (J3.2 v0.32)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('emitaudit'); });
  afterEach(() => safeRmSync(root));

  it('default emitAudit=true on n=0 path: emits exactly one predict_baserate audit', () => {
    expect(countPredictBaserateAudits(root)).toBe(0);
    const br = computePredictionBaserate(root, 'default', 'empty-class');
    expect(br.nClosed).toBe(0);
    expect(countPredictBaserateAudits(root)).toBe(1);
  });

  it('default emitAudit=true on n>0 path: emits exactly one predict_baserate audit', () => {
    const p = savePrediction(root, 'default', { classTag: 'pop', claimText: 'populated case', estimateValue: 2 });
    closePrediction(root, 'default', p.id, { closureState: 'closed', actualValue: 4 });
    expect(countPredictBaserateAudits(root)).toBe(0);
    const br = computePredictionBaserate(root, 'default', 'pop');
    expect(br.nClosed).toBe(1);
    expect(countPredictBaserateAudits(root)).toBe(1);
  });

  it('emitAudit=false on n=0 path: skips audit emit', () => {
    expect(countPredictBaserateAudits(root)).toBe(0);
    const br = computePredictionBaserate(root, 'default', 'empty-class', 'recall', /*emitAudit=*/ false);
    expect(br.nClosed).toBe(0);
    expect(countPredictBaserateAudits(root)).toBe(0);
  });

  it('emitAudit=false on n>0 path: skips audit emit', () => {
    const p = savePrediction(root, 'default', { classTag: 'pop', claimText: 'populated case', estimateValue: 2 });
    closePrediction(root, 'default', p.id, { closureState: 'closed', actualValue: 4 });
    expect(countPredictBaserateAudits(root)).toBe(0);
    const br = computePredictionBaserate(root, 'default', 'pop', 'recall', /*emitAudit=*/ false);
    expect(br.nClosed).toBe(1);
    expect(countPredictBaserateAudits(root)).toBe(0);
  });

  it('actor parameter still propagates to audit row when emitAudit=true', () => {
    computePredictionBaserate(root, 'default', 'with-actor', 'mcp');
    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT actor FROM audit_log WHERE op = 'predict_baserate' ORDER BY id DESC LIMIT 1`).get() as { actor: string };
      expect(row.actor).toBe('mcp');
    } finally {
      closeHippoDb(db);
    }
  });
});
