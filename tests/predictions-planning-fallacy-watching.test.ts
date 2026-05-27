/**
 * v1.13.4 / J3.2 follow-up — PlanningFallacyWatching variant.
 *
 * Closes the silent-no-class-match path identified by the 2026-05-27
 * dogfood diary Trial 2a (docs/dogfood/2026-05-27-track-j-warnings.md):
 * a natural-language query carrying a forward-claim phrase silently
 * emitted no signal when its tokens didn't overlap with any prediction
 * class tag. v1.13.4 surfaces these via a new `PlanningFallacyWatching`
 * type on `RecallResult.planningFallacyWatching`, mutually exclusive
 * with `planningFallacyHint`.
 *
 * Tests:
 *   1. Output.watching set on no_class_match (regex matched, no classes scored >=1)
 *   2. Output.watching set on tiebreak (>=2 classes tied at best score)
 *   3. Backward-compat: computePlanningFallacyHint wrapper still returns null on watching paths
 *   4. api.recall populates RecallResult.planningFallacyWatching when output is watching
 *   5. Mutual exclusivity: hint and watching never co-exist
 *
 * Project rule: always use real DB for tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryKind } from '../src/memory.js';
import {
  computePlanningFallacyOutput,
  computePlanningFallacyHint,
  savePrediction,
  closePrediction,
} from '../src/predictions.js';
import { recall, type Context } from '../src/api.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string): Context {
  return { hippoRoot: root, tenantId: 'default', actor: { subject: 'test:j32-watch', role: 'admin' } };
}

// Seed N closed predictions in a class so the baserate hint can fire on a
// matching query (used as the negative control: confirms hint path still works).
function seedClosedPredictions(root: string, classTag: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const p = savePrediction(root, 'default', {
      claimText: `prediction ${i} in ${classTag} for seeding baserate data`,
      classTag,
      estimateValue: 2,
      estimateUnit: 'days',
      actor: 'cli',
    });
    closePrediction(root, 'default', p.id, {
      closureState: 'closed',
      actualValue: 4,
      actor: 'cli',
    });
  }
}

describe('PlanningFallacyWatching (v1.13.4 / J3.2 follow-up)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('j32-watch'); });
  afterEach(() => safeRmSync(root));

  it('Output.watching set with reason=no_class_match when regex matches but no class scores >=1', () => {
    // No predictions seeded. Regex-matching query has no class to overlap with.
    const out = computePlanningFallacyOutput(
      root,
      'default',
      'this will take 2 days to finish the project',
      { actor: 'test' },
    );
    expect(out.hint).toBeUndefined();
    expect(out.watching).toBeDefined();
    expect(out.watching!.reason).toBe('no_class_match');
    expect(out.watching!.detectedPhrase).toMatch(/will\s+take\s+2\s+days/i);
    expect(out.watching!.suggestion).toMatch(/hippo predict --class/i);
  });

  it('Output.watching set with reason=tiebreak when >=2 classes tied at best overlap', () => {
    // Seed predictions in TWO classes that share NO query tokens between
    // themselves but each share 1 token with the query. Both classes should
    // tie at score 1, triggering the tiebreak path.
    // Query tokens (post-stopword removal): ["migration", "feature"]
    // Class "migration-effort" tokens: ["migration", "effort"] -> overlap {migration} = 1
    // Class "feature-effort" tokens: ["feature", "effort"] -> overlap {feature} = 1
    // -> tie at score 1.
    seedClosedPredictions(root, 'migration-effort', 1);
    seedClosedPredictions(root, 'feature-effort', 1);
    const out = computePlanningFallacyOutput(
      root,
      'default',
      'the migration feature will take 2 days',
      { actor: 'test' },
    );
    expect(out.hint).toBeUndefined();
    expect(out.watching).toBeDefined();
    expect(out.watching!.reason).toBe('tiebreak');
    expect(out.watching!.suggestion).toMatch(/tied|rename|refine/i);
  });

  it('backward-compat: computePlanningFallacyHint wrapper returns null on watching paths', () => {
    // The pre-v1.13.4 contract was: returns PlanningFallacyHint | null.
    // The watching variant only surfaces via computePlanningFallacyOutput.
    // The wrapper MUST still return null on no_class_match (otherwise
    // existing callers that haven't migrated yet would see undefined).
    const hint = computePlanningFallacyHint(
      root,
      'default',
      'this will take 2 days to finish',
      { actor: 'test' },
    );
    expect(hint).toBeNull();
  });

  it('Output returns {} (neither variant) when AUTODEBIAS=off (env-gated short-circuit)', () => {
    seedClosedPredictions(root, 'estimate-task', 3);
    const out = computePlanningFallacyOutput(
      root,
      'default',
      'the next task will take 2 days',
      { actor: 'test', mode: 'off' },
    );
    expect(out.hint).toBeUndefined();
    expect(out.watching).toBeUndefined();
  });

  it('Output returns {} (neither variant) on non-forward-claim queries', () => {
    seedClosedPredictions(root, 'estimate-task', 3);
    const out = computePlanningFallacyOutput(
      root,
      'default',
      'what is the architecture of this system',
      { actor: 'test' },
    );
    expect(out.hint).toBeUndefined();
    expect(out.watching).toBeUndefined();
  });

  it('Output returns {hint} (not watching) when class resolves AND nClosed > 0 (regression guard)', () => {
    seedClosedPredictions(root, 'estimate-task', 3);
    const out = computePlanningFallacyOutput(
      root,
      'default',
      'the next task will take 2 days',
      { actor: 'test' },
    );
    expect(out.hint).toBeDefined();
    expect(out.watching).toBeUndefined();
    expect(out.hint!.classTag).toBe('estimate-task');
  });

  it('api.recall populates RecallResult.planningFallacyWatching when output is watching', () => {
    // Seed at least one memory so recall has results (not strictly required
    // but exercises the populated-results path).
    writeEntry(root, createMemory('some unrelated memory content', {
      layer: Layer.Buffer,
      kind: 'raw' as MemoryKind,
      tenantId: 'default',
    }));
    const result = recall(ctxFor(root), { query: 'this will take 2 days to finish the project' });
    expect(result.planningFallacyWatching).toBeDefined();
    expect(result.planningFallacyWatching!.reason).toBe('no_class_match');
    expect(result.planningFallacyHint).toBeUndefined();
  });

  it('api.recall populates planningFallacyHint (NOT watching) when class resolves (mutual exclusivity)', () => {
    seedClosedPredictions(root, 'estimate-task', 3);
    writeEntry(root, createMemory('some unrelated memory content', {
      layer: Layer.Buffer,
      kind: 'raw' as MemoryKind,
      tenantId: 'default',
    }));
    const result = recall(ctxFor(root), { query: 'the next task will take 2 days' });
    expect(result.planningFallacyHint).toBeDefined();
    expect(result.planningFallacyWatching).toBeUndefined();
  });
});
