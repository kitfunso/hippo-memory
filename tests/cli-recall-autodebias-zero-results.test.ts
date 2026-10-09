// `hippo recall` keeps the planning-fallacy hint when no memory matches, as HTTP and MCP do.
// A prediction outlives its mirror memory, so forgetting the mirrors leaves the class resolvable with nothing to recall.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cmdRecall } from '../src/cli/recall.js';
import { forget, type Context } from '../src/api/index.js';
import { savePrediction, closePrediction } from '../src/store/predictions.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

const QUERY = 'the migration effort will take 3 days';
const DETECTED = '[detected: "will take 3 days"]';

interface ZeroRecallJson {
  results: unknown[];
  planningFallacyHint?: { classTag: string; nClosed: number; meanRatio: number };
  planningFallacyWatching?: { reason: string };
}

let root: string;

/** Three closed migration-effort predictions (actual twice the estimate), then every memory they wrote forgotten. */
function seedBaserateWithNoMemories(): void {
  for (const [estimate, actual] of [[2, 4], [3, 6], [4, 8]]) {
    const p = savePrediction(root, 'default', { classTag: 'migration-effort', claimText: `migration effort estimate ${estimate} days`, estimateValue: estimate });
    closePrediction(root, 'default', p.id, { closureState: 'closed', actualValue: actual });
  }
  const ctx: Context = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
  for (const entry of loadAllEntries(root)) forget(ctx, entry.id);
  expect(loadAllEntries(root)).toEqual([]);
}

async function recall(flags: Record<string, boolean> = {}): Promise<string> {
  const run = await runInProcess(() => cmdRecall(root, QUERY, flags));
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

async function recallJson(): Promise<ZeroRecallJson> {
  // SAFETY: the zero-result --json exit prints one object carrying these fields; each test asserts the ones it reads.
  return JSON.parse(await recall({ json: true })) as ZeroRecallJson;
}

describe('hippo recall with no matching memory keeps the planning-fallacy hint', () => {
  beforeEach(() => {
    root = makeRoot('cli-zero-plan');
    // A global store that does not exist keeps the recall on the local store alone.
    vi.stubEnv('HIPPO_HOME', join(root, 'no-global'));
    for (const name of ['HIPPO_TENANT', 'HIPPO_AUTODEBIAS']) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('--json returns no results and still carries planningFallacyHint', async () => {
    seedBaserateWithNoMemories();
    const out = await recallJson();

    expect(out.results).toEqual([]);
    expect(out.planningFallacyHint).toMatchObject({ classTag: 'migration-effort', nClosed: 3, meanRatio: 2 });
  });

  it('text prints the hint line, with the detected phrase quoted, above the no-memories line', async () => {
    seedBaserateWithNoMemories();
    const text = await recall();

    const hintAt = text.indexOf('Planning fallacy hint (class: migration-effort)');
    expect(hintAt).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('No memories found for:')).toBeGreaterThan(hintAt);
    expect(text).toContain(DETECTED);
  });

  it('with no prediction class to match, both outputs carry the watching notice instead', async () => {
    const out = await recallJson();
    const text = await recall();

    expect(out.planningFallacyHint).toBeUndefined();
    expect(out.planningFallacyWatching?.reason).toBe('no_class_match');
    const watchAt = text.indexOf('Planning fallacy: watching this query (reason: no_class_match)');
    expect(watchAt).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('No memories found for:')).toBeGreaterThan(watchAt);
    expect(text).toContain(DETECTED);
  });
});
