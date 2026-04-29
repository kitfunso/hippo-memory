import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store.js';
import { runIncidentRecallEval } from '../benchmarks/e1.3/incident-recall-eval.js';

describe('slack incident recall (success criterion)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-eval-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('beats transcript-tail baseline on at least 7/10 scenarios', async () => {
    const r = await runIncidentRecallEval({ hippoRoot: root });
    expect(r.scenarios).toHaveLength(10);
    expect(r.scenariosBeaten).toBeGreaterThanOrEqual(7);
  });
});
