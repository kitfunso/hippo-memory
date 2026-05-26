/**
 * J3.2 — api.recall integration with planningFallacyHint auto-injection.
 *
 * Asserts the orchestrator (computePlanningFallacyHint) wires correctly
 * through api.recall: hint populated only when ALL conditions met (env
 * != off, forward-claim match, class resolves uniquely, nClosed > 0).
 * Audit attribution flows from ctx.actor.subject -> inner
 * computePredictionBaserate so MCP-/HTTP-originated calls don't default
 * to 'cli'.
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 4, Task 9).
 * Project rule: always use real DB for tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { recall, type Context } from '../src/api.js';
import { savePrediction, closePrediction } from '../src/predictions.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string, subject: string = 'cli'): Context {
  return { hippoRoot: root, tenantId: 'default', actor: { subject, role: 'admin' } };
}

// Seed 3 closed predictions in class "migration-effort" with mean_ratio = 2.0
function seedMigrationEffortBaserate(root: string): void {
  for (const [est, act] of [[2, 4], [3, 6], [4, 8]] as Array<[number, number]>) {
    const p = savePrediction(root, 'default', {
      classTag: 'migration-effort',
      claimText: `migration effort estimate ${est} days`,
      estimateValue: est,
    });
    closePrediction(root, 'default', p.id, { closureState: 'closed', actualValue: act });
  }
}

function countAuditOps(root: string, op: string): number {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE op = ?`).get(op) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

function lastAuditActor(root: string, op: string): string | null {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT actor FROM audit_log WHERE op = ? ORDER BY id DESC LIMIT 1`).get(op) as { actor: string } | undefined;
    return row?.actor ?? null;
  } finally {
    closeHippoDb(db);
  }
}

describe('api.recall planningFallacyHint (J3.2, v0.32)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('j32');
    delete process.env.HIPPO_AUTODEBIAS;
  });
  afterEach(() => {
    safeRmSync(root);
    delete process.env.HIPPO_AUTODEBIAS;
  });

  it('populates planningFallacyHint when query has forward-claim AND class resolves AND nClosed > 0', () => {
    seedMigrationEffortBaserate(root);
    const result = recall(ctxFor(root), { query: 'the migration effort will take 3 days' });
    expect(result.planningFallacyHint).toBeDefined();
    expect(result.planningFallacyHint!.classTag).toBe('migration-effort');
    expect(result.planningFallacyHint!.source).toBe('j3.2-auto');
    expect(result.planningFallacyHint!.nClosed).toBe(3);
    expect(result.planningFallacyHint!.meanRatio).toBeCloseTo(2.0, 6);
    expect(result.planningFallacyHint!.detectedPhrase.toLowerCase()).toContain('will take');
    expect(result.planningFallacyHint!.baserateSummary).toContain('migration-effort');
  });

  it('absent when query has no forward-claim phrase', () => {
    seedMigrationEffortBaserate(root);
    const result = recall(ctxFor(root), { query: 'tell me about migration auth flow' });
    expect(result.planningFallacyHint).toBeUndefined();
  });

  it('absent when forward-claim detected but no class scored >= 1 (no_class_match audit fires)', () => {
    seedMigrationEffortBaserate(root);
    const result = recall(ctxFor(root), { query: 'unrelated stuff will take 3 days' });
    expect(result.planningFallacyHint).toBeUndefined();
    expect(countAuditOps(root, 'recall_autodebias_hint_no_class_match')).toBe(1);
    expect(countAuditOps(root, 'recall_autodebias_hint')).toBe(0);
  });

  it('absent when class has no closed predictions yet (only open ones)', () => {
    savePrediction(root, 'default', {
      classTag: 'migration-effort',
      claimText: 'migration prediction open',
      estimateValue: 3,
    });
    const result = recall(ctxFor(root), { query: 'migration effort will take 5 days' });
    expect(result.planningFallacyHint).toBeUndefined();
  });

  it('absent under HIPPO_AUTODEBIAS=off even when conditions otherwise met', () => {
    seedMigrationEffortBaserate(root);
    process.env.HIPPO_AUTODEBIAS = 'off';
    const result = recall(ctxFor(root), { query: 'migration effort will take 3 days' });
    expect(result.planningFallacyHint).toBeUndefined();
    // No audit fires either — off short-circuits before the regex gate.
    expect(countAuditOps(root, 'recall_autodebias_hint')).toBe(0);
    expect(countAuditOps(root, 'recall_autodebias_hint_no_class_match')).toBe(0);
  });

  it('absent when query is empty', () => {
    seedMigrationEffortBaserate(root);
    const result = recall(ctxFor(root), { query: '' });
    expect(result.planningFallacyHint).toBeUndefined();
  });

  it('silent on tie: 2 classes with equal overlap returns no hint + emits tiebreak audit', () => {
    // Seed two classes that BOTH overlap with "migration" token.
    for (const [est, act] of [[2, 4]] as Array<[number, number]>) {
      const a = savePrediction(root, 'default', { classTag: 'migration-effort', claimText: 'first prediction', estimateValue: est });
      closePrediction(root, 'default', a.id, { closureState: 'closed', actualValue: act });
      const b = savePrediction(root, 'default', { classTag: 'migration-risk', claimText: 'second prediction', estimateValue: est });
      closePrediction(root, 'default', b.id, { closureState: 'closed', actualValue: act });
    }
    // Query "migration will take 3 days" overlaps only on "migration" — tie.
    const result = recall(ctxFor(root), { query: 'migration will take 3 days' });
    expect(result.planningFallacyHint).toBeUndefined();
    expect(countAuditOps(root, 'recall_autodebias_hint_tiebreak')).toBe(1);
    expect(countAuditOps(root, 'recall_autodebias_hint')).toBe(0);
  });

  it('actor attribution: MCP-originated recall writes audit row with actor=mcp (not cli default)', () => {
    seedMigrationEffortBaserate(root);
    const mcpCtx: Context = { hippoRoot: root, tenantId: 'default', actor: { subject: 'mcp', role: 'admin' } };
    recall(mcpCtx, { query: 'migration effort will take 3 days' });
    expect(lastAuditActor(root, 'recall_autodebias_hint')).toBe('mcp');
  });

  it('actor attribution: HTTP api_key:* subject flows through to audit', () => {
    seedMigrationEffortBaserate(root);
    const httpCtx: Context = { hippoRoot: root, tenantId: 'default', actor: { subject: 'api_key:hk_demo123', role: 'admin' } };
    recall(httpCtx, { query: 'migration effort will take 3 days' });
    expect(lastAuditActor(root, 'recall_autodebias_hint')).toBe('api_key:hk_demo123');
  });

  it('predict_baserate audit channel NOT polluted on auto-hint success (emitAudit=false path)', () => {
    seedMigrationEffortBaserate(root);
    // Baseline: 0 predict_baserate rows after seeding.
    const baselineBaserate = countAuditOps(root, 'predict_baserate');
    const result = recall(ctxFor(root), { query: 'migration effort will take 3 days' });
    expect(result.planningFallacyHint).toBeDefined();
    // J3.2 emits recall_autodebias_hint, NOT predict_baserate.
    expect(countAuditOps(root, 'recall_autodebias_hint')).toBe(1);
    expect(countAuditOps(root, 'predict_baserate')).toBe(baselineBaserate);
  });

  it('cross-tenant scoping: tenant-b query gets no hint from tenant-a predictions', () => {
    // Seed tenant-a only.
    const ctxA: Context = { hippoRoot: root, tenantId: 'tenant-a', actor: { subject: 'cli', role: 'admin' } };
    for (const [est, act] of [[2, 4], [3, 6]] as Array<[number, number]>) {
      const p = savePrediction(root, 'tenant-a', { classTag: 'migration-effort', claimText: 'tenant a prediction', estimateValue: est });
      closePrediction(root, 'tenant-a', p.id, { closureState: 'closed', actualValue: act });
    }
    // Tenant-a query gets the hint.
    const resultA = recall(ctxA, { query: 'migration effort will take 3 days' });
    expect(resultA.planningFallacyHint).toBeDefined();
    // Tenant-b query gets nothing.
    const ctxB: Context = { hippoRoot: root, tenantId: 'tenant-b', actor: { subject: 'cli', role: 'admin' } };
    const resultB = recall(ctxB, { query: 'migration effort will take 3 days' });
    expect(resultB.planningFallacyHint).toBeUndefined();
  });
});
