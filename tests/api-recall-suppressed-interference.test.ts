/**
 * J1 — first wire-up of `suppressedByInterference` counter on
 * RecallResult.suppressionSummary.
 *
 * The counter was hardcoded to 0 since v1.12.13 (C5) as a placeholder
 * for future B4-depth or J1-anchoring work. v1.13.2 / J1 lights it up:
 * each pipeline's buildSuppressionSummary increments the counter by 1
 * when ITS OWN R2 memory_dominance verdict fires.
 *
 * This test focuses on api.recall's counter. CLI + MCP increments are
 * tested in cli-recall-anchoring.test.ts + mcp-recall-anchoring.test.ts.
 *
 * Real DB throughout (project convention).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { recall, type Context } from '../src/api.js';
import { hashQueryText, type RecallHistorySnapshot, type RecallHistoryEntry } from '../src/recall-history.js';
import { makeRoot } from './_helpers/make-root.js';

function seed(root: string, content: string): string {
  const m = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    tenantId: 'default',
  });
  writeEntry(root, m);
  return m.id;
}

function entry(queryHash: number, topMemoryId: string | null): RecallHistoryEntry {
  return { queryHash, topMemoryId, ts: new Date().toISOString() };
}

describe('suppressedByInterference counter', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('j1-interference');
    delete process.env.HIPPO_ANCHORING;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HIPPO_ANCHORING;
  });

  it('was always 0 pre-v1.13.2 (no anchoring snapshot → stays 0)', () => {
    seed(root, 'foo bar baz');
    const ctx: Context = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
    const result = recall(ctx, { query: 'foo bar baz' });
    expect(result.suppressionSummary!.suppressedByInterference).toBe(0);
  });

  it('is 0 on R1 query_repeat (only memory_dominance counts as interference)', () => {
    const id = seed(root, 'foo bar baz');
    const realHash = hashQueryText('foo bar baz');
    const ctx: Context = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
    // Snapshot: SAME queryHash as current call returning same top → R1 fires.
    const result = recall(ctx, { query: 'foo bar baz', recallHistory: [entry(realHash, id)] });
    // R1 fires (or doesn't, depending on cooldown); either way suppressedByInterference
    // is 0 because only memory_dominance counts as interference.
    expect(result.suppressionSummary!.suppressedByInterference).toBe(0);
  });

  it('is 1 on R2 memory_dominance', () => {
    const id = seed(root, 'foo bar baz');
    const snapshot: RecallHistorySnapshot = [
      entry(111, id),
      entry(222, id),
    ];
    const ctx: Context = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
    const result = recall(ctx, { query: 'foo bar baz', recallHistory: snapshot });
    expect(result.suppressionSummary!.suppressedByInterference).toBe(1);
  });
});
