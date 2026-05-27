/**
 * J1 anchoring — api.recall integration tests.
 *
 * Asserts:
 * - api.recall populates RecallResult.anchoringHint when opts.recallHistory
 *   is passed AND R1 or R2 conditions are met against the just-computed top-1
 * - HIPPO_ANCHORING=off short-circuits (returns no hint regardless)
 * - api.recall is PURE: calling twice with same opts.recallHistory returns
 *   identical results (return-value purity; audit_log delta is expected)
 * - suppressedByInterference increments on R2 fire (lights up the placeholder
 *   counter that has been hardcoded to 0 since v1.12.13)
 *
 * Real DB throughout (project convention).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { recall, type Context } from '../src/api.js';
import {
  hashQueryText,
  type RecallHistorySnapshot,
  type RecallHistoryEntry,
} from '../src/recall-history.js';

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

function seedQueryMatchingMemory(root: string, content: string): string {
  const mem = createMemory(content, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    tenantId: 'default',
  });
  writeEntry(root, mem);
  return mem.id;
}

function entry(queryHash: number, topMemoryId: string | null, anchoredOn?: string): RecallHistoryEntry {
  const e: RecallHistoryEntry = { queryHash, topMemoryId, ts: new Date().toISOString() };
  if (anchoredOn !== undefined) e.anchoredOn = anchoredOn;
  return e;
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

describe('api.recall anchoringHint (J1, v0.33)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('j1-api');
    delete process.env.HIPPO_ANCHORING;
  });
  afterEach(() => {
    safeRmSync(root);
    delete process.env.HIPPO_ANCHORING;
  });

  it('populates anchoringHint on R2 (memory_dominance) when snapshot has 2 prior wins for same memory', () => {
    const memId = seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    // Two prior recalls in the snapshot, both returning this memory id.
    const snapshot: RecallHistorySnapshot = [
      entry(111, memId),
      entry(222, memId),
    ];
    const result = recall(ctxFor(root), {
      query: 'frobnicate baz quux',
      recallHistory: snapshot,
    });
    expect(result.anchoringHint).toBeDefined();
    expect(result.anchoringHint!.reason).toBe('memory_dominance');
    expect(result.anchoringHint!.memoryId).toBe(memId);
    expect(result.anchoringHint!.queryCount).toBe(3);
  });

  it('absent when no recallHistory passed (CLI-routed call path simulation)', () => {
    seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const result = recall(ctxFor(root), { query: 'frobnicate baz quux' });
    expect(result.anchoringHint).toBeUndefined();
  });

  it('absent when HIPPO_ANCHORING=off even with valid snapshot', () => {
    const memId = seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const snapshot: RecallHistorySnapshot = [
      entry(111, memId),
      entry(222, memId),
    ];
    process.env.HIPPO_ANCHORING = 'off';
    const result = recall(ctxFor(root), {
      query: 'frobnicate baz quux',
      recallHistory: snapshot,
    });
    expect(result.anchoringHint).toBeUndefined();
  });

  it('absent when snapshot is empty', () => {
    seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const result = recall(ctxFor(root), {
      query: 'frobnicate baz quux',
      recallHistory: [],
    });
    expect(result.anchoringHint).toBeUndefined();
  });

  it('absent on R1 query_repeat when current top is null (zero memory results)', () => {
    // No memory seeded, so top is null. R1 can't fire on null top.
    const snapshot: RecallHistorySnapshot = [entry(hashQueryText('xyzzy plugh'), null)];
    const result = recall(ctxFor(root), {
      query: 'xyzzy plugh',
      recallHistory: snapshot,
    });
    expect(result.anchoringHint).toBeUndefined();
  });

  it('emits recall_anchor_detected_memory_dominance audit on R2', () => {
    const memId = seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const snapshot: RecallHistorySnapshot = [
      entry(111, memId),
      entry(222, memId),
    ];
    expect(countAuditOps(root, 'recall_anchor_detected_memory_dominance')).toBe(0);
    recall(ctxFor(root), { query: 'frobnicate baz quux', recallHistory: snapshot });
    expect(countAuditOps(root, 'recall_anchor_detected_memory_dominance')).toBe(1);
  });

  it('suppressedByInterference is INCREMENTED to 1 on R2 (was always 0 pre-v1.13.2)', () => {
    const memId = seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const snapshot: RecallHistorySnapshot = [
      entry(111, memId),
      entry(222, memId),
    ];
    const result = recall(ctxFor(root), {
      query: 'frobnicate baz quux',
      recallHistory: snapshot,
    });
    expect(result.suppressionSummary!.suppressedByInterference).toBe(1);
  });

  it('suppressedByInterference stays 0 when no R2 fires', () => {
    seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const result = recall(ctxFor(root), { query: 'frobnicate baz quux' });
    expect(result.suppressionSummary!.suppressedByInterference).toBe(0);
  });

  it('api.recall is return-value pure: identical opts.recallHistory snapshot → identical anchoringHint result', () => {
    const memId = seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const snapshot: RecallHistorySnapshot = [
      entry(111, memId),
      entry(222, memId),
    ];
    const r1 = recall(ctxFor(root), { query: 'frobnicate baz quux', recallHistory: snapshot });
    const r2 = recall(ctxFor(root), { query: 'frobnicate baz quux', recallHistory: snapshot });
    expect(r1.anchoringHint).toEqual(r2.anchoringHint);
    // Audit_log will have 2 rows (one per call) — that's expected and not a purity violation.
  });

  it('cross-tenant scoping: tenant-b snapshot does not interact with tenant-a context', () => {
    const memId = seedQueryMatchingMemory(root, 'frobnicate baz quux content');
    const snapshot: RecallHistorySnapshot = [
      entry(111, memId),
      entry(222, memId),
    ];
    // ctx is tenant-default; snapshot rows reference memId which is also tenant-default.
    // Pass to a tenant-b ctx — top will be null (no matching memory in tenant-b).
    const ctxB: Context = { hippoRoot: root, tenantId: 'tenant-b', actor: { subject: 'cli', role: 'admin' } };
    const result = recall(ctxB, { query: 'frobnicate baz quux', recallHistory: snapshot });
    // No matching memory in tenant-b → top null → R2 cannot fire (current can't extend dominance).
    expect(result.anchoringHint).toBeUndefined();
  });
});
