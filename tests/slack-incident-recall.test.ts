import { describe, it, expect, beforeEach } from 'vitest';
import { runIncidentRecallEval } from '../benchmarks/e1.3/incident-recall-eval.js';
import { makeRoot } from './_helpers/make-root.js';

describe('slack incident recall (success criterion)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-eval');
  });

  // Ingests and recalls ten incident scenarios against a real store.
  it('beats transcript-tail baseline on at least 7/10 scenarios', async () => {
    const r = await runIncidentRecallEval({ hippoRoot: root });
    expect(r.scenarios).toHaveLength(10);
    expect(r.scenariosBeaten).toBeGreaterThanOrEqual(7);
  }, 40_000);
});
