/**
 * J3 reference-class / planning-fallacy detector — store-layer tests.
 * Docs: docs/plans/2026-05-26-j3-baserate-detector.md
 *
 * Covers:
 * 1. Empty class returns nClosed=0 + null stats + empty summary
 * 2. Single closed prediction returns n=1 with correct stats
 * 3. Multiple closed predictions compute mean/median/MAE correctly
 * 4. Open + closed mixed only counts closed
 * 5. closed-unknown excluded (no actual_value)
 * 6. estimate_value=0 row counts in nClosed + MAE but NOT in ratio calc
 * 7. Cross-tenant scoping: empty result
 * 8. predict_baserate audit emitted on every call (including n=0)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  savePrediction,
  closePrediction,
  computePredictionBaserate,
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

describe('computePredictionBaserate (J3 baserate detector, v0.31)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('j3'); });
  afterEach(() => safeRmSync(home));

  it('empty class returns nClosed=0 + null stats + empty summary', () => {
    const br = computePredictionBaserate(home, 'default', 'empty-class');
    expect(br.classTag).toBe('empty-class');
    expect(br.nClosed).toBe(0);
    expect(br.nRatioEligible).toBe(0);
    expect(br.meanEstimate).toBeNull();
    expect(br.meanActual).toBeNull();
    expect(br.meanRatio).toBeNull();
    expect(br.p50Ratio).toBeNull();
    expect(br.mae).toBeNull();
    expect(br.summary).toBe('');
  });

  it('single closed prediction returns n=1 with correct stats', () => {
    const p = savePrediction(home, 'default', {
      classTag: 'one-test',
      claimText: 'single estimate',
      estimateValue: 2,
    });
    closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: 3 });

    const br = computePredictionBaserate(home, 'default', 'one-test');
    expect(br.nClosed).toBe(1);
    expect(br.nRatioEligible).toBe(1);
    expect(br.meanEstimate).toBe(2);
    expect(br.meanActual).toBe(3);
    expect(br.meanRatio).toBeCloseTo(1.5, 6);
    expect(br.p50Ratio).toBeCloseTo(1.5, 6);
    expect(br.mae).toBe(1);
    expect(br.summary).toContain('Last 1 estimate');
    expect(br.summary).toContain('1.50x actual');
  });

  it('multiple closed predictions compute mean/median/MAE correctly', () => {
    // Estimates [2, 4, 6]; Actuals [4, 6, 6]
    // Ratios: 2.0, 1.5, 1.0; mean=1.5, median=1.5
    // MAE: |4-2| + |6-4| + |6-6| / 3 = 4/3
    const ids: number[] = [];
    for (const [est, act] of [[2, 4], [4, 6], [6, 6]] as Array<[number, number]>) {
      const p = savePrediction(home, 'default', {
        classTag: 'multi-test',
        claimText: `est ${est} act ${act}`,
        estimateValue: est,
      });
      closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: act });
      ids.push(p.id);
    }

    const br = computePredictionBaserate(home, 'default', 'multi-test');
    expect(br.nClosed).toBe(3);
    expect(br.nRatioEligible).toBe(3);
    expect(br.meanEstimate).toBeCloseTo(4, 6);
    expect(br.meanActual).toBeCloseTo(16 / 3, 6);
    expect(br.meanRatio).toBeCloseTo(1.5, 6);
    expect(br.p50Ratio).toBeCloseTo(1.5, 6);
    expect(br.mae).toBeCloseTo(4 / 3, 6);
  });

  it('open + closed mixed only counts closed in baserate', () => {
    const closed = savePrediction(home, 'default', { classTag: 'mixed', claimText: 'closed one', estimateValue: 2 });
    closePrediction(home, 'default', closed.id, { closureState: 'closed', actualValue: 4 });
    savePrediction(home, 'default', { classTag: 'mixed', claimText: 'open one', estimateValue: 10 });

    const br = computePredictionBaserate(home, 'default', 'mixed');
    expect(br.nClosed).toBe(1);
    expect(br.meanEstimate).toBe(2);
    expect(br.meanActual).toBe(4);
  });

  it('closed-unknown excluded from baserate (no actual_value to compare)', () => {
    const a = savePrediction(home, 'default', { classTag: 'unk', claimText: 'categorical one', estimateValue: 1 });
    closePrediction(home, 'default', a.id, { closureState: 'closed-unknown', closureNote: 'not measurable' });
    const b = savePrediction(home, 'default', { classTag: 'unk', claimText: 'numeric one', estimateValue: 2 });
    closePrediction(home, 'default', b.id, { closureState: 'closed', actualValue: 4 });

    const br = computePredictionBaserate(home, 'default', 'unk');
    expect(br.nClosed).toBe(1); // only the closed-with-actual row
    expect(br.meanEstimate).toBe(2);
    expect(br.meanActual).toBe(4);
  });

  it('estimate_value=0 row counts in nClosed + MAE but NOT in ratio calc', () => {
    const zero = savePrediction(home, 'default', { classTag: 'zero', claimText: 'zero estimate', estimateValue: 0 });
    closePrediction(home, 'default', zero.id, { closureState: 'closed', actualValue: 3 });
    const norm = savePrediction(home, 'default', { classTag: 'zero', claimText: 'normal estimate', estimateValue: 2 });
    closePrediction(home, 'default', norm.id, { closureState: 'closed', actualValue: 4 });

    const br = computePredictionBaserate(home, 'default', 'zero');
    expect(br.nClosed).toBe(2);
    expect(br.nRatioEligible).toBe(1); // only the non-zero estimate
    expect(br.meanRatio).toBeCloseTo(2, 6); // 4 / 2
    expect(br.p50Ratio).toBeCloseTo(2, 6);
    // MAE: |3-0| + |4-2| / 2 = 5/2 = 2.5
    expect(br.mae).toBe(2.5);
  });

  it('cross-tenant scoping: tenant-b request on tenant-a class returns empty', () => {
    const p = savePrediction(home, 'tenant-a', { classTag: 'scope-test', claimText: 'tenant a only', estimateValue: 1 });
    closePrediction(home, 'tenant-a', p.id, { closureState: 'closed', actualValue: 2 });

    const aResult = computePredictionBaserate(home, 'tenant-a', 'scope-test');
    expect(aResult.nClosed).toBe(1);

    const bResult = computePredictionBaserate(home, 'tenant-b', 'scope-test');
    expect(bResult.nClosed).toBe(0);
    expect(bResult.summary).toBe('');
  });

  it('predict_baserate audit emitted on every call (including n=0)', () => {
    // n=0 call
    computePredictionBaserate(home, 'default', 'audit-test');

    // Add data + non-zero call
    const p = savePrediction(home, 'default', { classTag: 'audit-test', claimText: 'audit data', estimateValue: 1 });
    closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: 2 });
    computePredictionBaserate(home, 'default', 'audit-test');

    const db = openHippoDb(home);
    try {
      const auditRows = db.prepare(
        `SELECT op, target_id, metadata_json FROM audit_log WHERE op = 'predict_baserate' ORDER BY id`
      ).all() as Array<{ op: string; target_id: string; metadata_json: string }>;
      expect(auditRows.length).toBe(2);
      expect(auditRows[0].target_id).toBe('audit-test');
      const meta0 = JSON.parse(auditRows[0].metadata_json) as { class_tag: string; n_closed: number };
      expect(meta0.n_closed).toBe(0);
      const meta1 = JSON.parse(auditRows[1].metadata_json) as { class_tag: string; n_closed: number };
      expect(meta1.n_closed).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });
});
