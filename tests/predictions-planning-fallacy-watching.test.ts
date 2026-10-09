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
 *   3. api.recall populates RecallResult.planningFallacyWatching when output is watching
 *   4. Mutual exclusivity: hint and watching never co-exist
 *
 * Project rule: always use real DB for tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { Layer} from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { detectPlanningClaim } from '../src/predictions/planning-fallacy.js';
import { savePrediction, closePrediction } from '../src/store/predictions.js';
import { recall, type Context } from '../src/api.js';
import { makeRoot } from './_helpers/make-root.js';

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
    });
    closePrediction(root, 'default', p.id, {
      closureState: 'closed',
      actualValue: 4,
    });
  }
}

describe('PlanningFallacyWatching (v1.13.4 / J3.2 follow-up)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('j32-watch'); });
  afterEach(() => safeRmSync(root));

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
    const out = recall(ctxFor(root), { query: 'the migration feature will take 2 days' });
    expect(out.planningFallacyHint).toBeUndefined();
    expect(out.planningFallacyWatching).toBeDefined();
    expect(out.planningFallacyWatching!.reason).toBe('tiebreak');
    expect(out.planningFallacyWatching!.suggestion).toMatch(/tied|rename|refine/i);
  });

  it('no claim is detected when mode is off, so neither variant can follow (short-circuit)', () => {
    expect(detectPlanningClaim('the next task will take 2 days', { mode: 'off' })).toBeNull();
    expect(detectPlanningClaim('the next task will take 2 days', { mode: 'regex' })).not.toBeNull();
  });

  it('Output returns {} (neither variant) on non-forward-claim queries', () => {
    seedClosedPredictions(root, 'estimate-task', 3);
    const out = recall(ctxFor(root), { query: 'what is the architecture of this system' });
    expect(out.planningFallacyHint).toBeUndefined();
    expect(out.planningFallacyWatching).toBeUndefined();
  });

  it('api.recall populates RecallResult.planningFallacyWatching when output is watching', () => {
    // Seed at least one memory so recall has results (not strictly required
    // but exercises the populated-results path).
    writeEntry(root, createMemory('some unrelated memory content', {
      layer: Layer.Buffer,
      kind: 'raw',
      tenantId: 'default',
    }));
    const result = recall(ctxFor(root), { query: 'this will take 2 days to finish the project' });
    expect(result.planningFallacyWatching).toBeDefined();
    expect(result.planningFallacyWatching!.reason).toBe('no_class_match');
    expect(result.planningFallacyWatching!.detectedPhrase).toMatch(/will\s+take\s+2\s+days/i);
    expect(result.planningFallacyWatching!.suggestion).toMatch(/hippo predict --class/i);
    expect(result.planningFallacyHint).toBeUndefined();
  });

  it('api.recall populates planningFallacyHint (NOT watching) when class resolves (mutual exclusivity)', () => {
    seedClosedPredictions(root, 'estimate-task', 3);
    writeEntry(root, createMemory('some unrelated memory content', {
      layer: Layer.Buffer,
      kind: 'raw',
      tenantId: 'default',
    }));
    const result = recall(ctxFor(root), { query: 'the next task will take 2 days' });
    expect(result.planningFallacyHint).toBeDefined();
    expect(result.planningFallacyHint!.classTag).toBe('estimate-task');
    expect(result.planningFallacyWatching).toBeUndefined();
  });
});
