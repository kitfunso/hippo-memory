import { describe, it, expect, beforeEach } from 'vitest';
import { runIncidentRecallEval } from '../../benchmarks/e1.3/incident-recall-eval.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('slack incident recall (success criterion)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-eval');
  });

  // Ingests and recalls ten incident scenarios against a real store.
  it('beats transcript-tail baseline on every one of the 10 scenarios', async () => {
    const r = await runIncidentRecallEval({ hippoRoot: root });
    expect(r.scenarios).toHaveLength(10);
    // Named, so the one scenario that regresses shows in the diff.
    expect(r.scenarios.filter((s) => s.beat).map((s) => s.id)).toEqual([
      'S01-incident', 'S02-incident', 'S03-incident', 'S04-incident', 'S05-incident',
      'S06-incident', 'S07-incident', 'S08-incident', 'S09-incident', 'S10-incident',
    ]);
    expect(r.scenariosBeaten).toBe(10);
  }, 40_000);
});
