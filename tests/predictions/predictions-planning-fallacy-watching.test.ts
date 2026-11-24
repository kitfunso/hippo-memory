import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { detectPlanningClaim } from '../../src/domain/predictions/planning-fallacy.js';
import { savePrediction } from '../_helpers/save-prediction.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { closePrediction, writeEntry } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';

function ctxFor(root: string): FullContext {
  return apiCtx(root, 'default', { subject: 'test:j32-watch', role: 'admin' });
}

async function seedClosedPredictions(root: string, classTag: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const p = await savePrediction(root, 'default', {
      claimText: `prediction ${i} in ${classTag} for seeding baserate data`,
      classTag,
      estimateValue: 2,
      estimateUnit: 'days',
    });
    await closePrediction(root, 'default', p.id, {
      closureState: 'closed',
      actualValue: 4,
    });
  }
}

describe('PlanningFallacyWatching', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('j32-watch');
  });
  afterEach(() => removeDir(root));

  it('Output.watching set with reason=tiebreak when >=2 classes tied at best overlap', async () => {
    await seedClosedPredictions(root, 'migration-effort', 1);
    await seedClosedPredictions(root, 'feature-effort', 1);
    const out = await retrieve(ctxFor(root), { query: 'the migration feature will take 2 days' });
    expect(out.planningFallacyHint).toBeUndefined();
    expect(out.planningFallacyWatching!.reason).toBe('tiebreak');
    expect(out.planningFallacyWatching!.suggestion).toMatch(/tied|rename|refine/i);
  });

  it('no claim is detected when mode is off, so neither variant can follow (short-circuit)', () => {
    expect(detectPlanningClaim('the next task will take 2 days', { mode: 'off' })).toBeNull();
    expect(detectPlanningClaim('the next task will take 2 days', { mode: 'regex' })).not.toBeNull();
  });

  it('Output returns {} (neither variant) on non-forward-claim queries', async () => {
    await seedClosedPredictions(root, 'estimate-task', 3);
    const out = await retrieve(ctxFor(root), { query: 'what is the architecture of this system' });
    expect(out.planningFallacyHint).toBeUndefined();
    expect(out.planningFallacyWatching).toBeUndefined();
  });

  it('api.recall populates RecallResult.planningFallacyWatching when output is watching', async () => {
    writeEntry(
      root,
      createMemory('some unrelated memory content', {
        layer: Layer.Buffer,
        kind: 'raw',
        tenantId: 'default',
      }),
    );
    const result = await retrieve(ctxFor(root), { query: 'this will take 2 days to finish the project' });
    expect(result.planningFallacyWatching!.reason).toBe('no_class_match');
    expect(result.planningFallacyWatching!.detectedPhrase).toMatch(/will\s+take\s+2\s+days/i);
    expect(result.planningFallacyWatching!.suggestion).toMatch(/hippo predict --class/i);
    expect(result.planningFallacyHint).toBeUndefined();
  });

  it('api.recall populates planningFallacyHint (NOT watching) when class resolves (mutual exclusivity)', async () => {
    await seedClosedPredictions(root, 'estimate-task', 3);
    writeEntry(
      root,
      createMemory('some unrelated memory content', {
        layer: Layer.Buffer,
        kind: 'raw',
        tenantId: 'default',
      }),
    );
    const result = await retrieve(ctxFor(root), { query: 'the next task will take 2 days' });
    expect(result.planningFallacyHint!.classTag).toBe('estimate-task');
    expect(result.planningFallacyWatching).toBeUndefined();
  });
});
