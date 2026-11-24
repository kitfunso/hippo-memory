import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

let tmpDir: string;
let hippoDir: string;

async function runHippo(args: string[], env: Record<string, string> = {}): Promise<string> {
  const vars = {
    HIPPO_HOME: path.join(tmpDir, 'global'),
    HIPPO_SCOPE: '',
    GSTACK_SKILL: '',
    OPENCLAW_SKILL: '',
    ...env,
  };
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  const saved = process.cwd();
  process.chdir(tmpDir);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

beforeEach(() => {
  ({ base: tmpDir, root: hippoDir } = makeStore('scope-boost'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scope boost scoring', () => {
  it('scoped memory ranks higher when scope matches', async () => {
    const scoped = createMemory('always use real DB for integration tests', {
      layer: Layer.Episodic,
      tags: ['scope:plan-eng-review'],
      source: 'cli',
    });
    const unscoped = createMemory('always use real DB for unit tests', {
      layer: Layer.Episodic,
      tags: [],
      source: 'cli',
    });
    writeEntry(hippoDir, scoped);
    writeEntry(hippoDir, unscoped);

    const out = await runHippo(['recall', 'real DB tests', '--scope', 'plan-eng-review', '--json', '--limit', '5']);
    const parsed = JSON.parse(out);
    expect(parsed.results.length).toBeGreaterThanOrEqual(2);

    const scopedResult = parsed.results.find((r: { id: string }) => r.id === scoped.id);
    const unscopedResult = parsed.results.find((r: { id: string }) => r.id === unscoped.id);
    expect(scopedResult?.id).toBe(scoped.id);
    expect(unscopedResult?.id).toBe(unscoped.id);
    expect(scopedResult.score).toBeGreaterThan(unscopedResult.score);
  });

  it('scoped memory ranks lower when scope mismatches', async () => {
    const scoped = createMemory('always use real DB for integration tests', {
      layer: Layer.Episodic,
      tags: ['scope:plan-eng-review'],
      source: 'cli',
    });
    const unscoped = createMemory('always use real DB for unit tests', {
      layer: Layer.Episodic,
      tags: [],
      source: 'cli',
    });
    writeEntry(hippoDir, scoped);
    writeEntry(hippoDir, unscoped);

    const out = await runHippo(['recall', 'real DB tests', '--scope', 'qa', '--json', '--limit', '5']);
    const parsed = JSON.parse(out);
    expect(parsed.results.length).toBeGreaterThanOrEqual(2);

    const scopedResult = parsed.results.find((r: { id: string }) => r.id === scoped.id);
    const unscopedResult = parsed.results.find((r: { id: string }) => r.id === unscoped.id);
    expect(scopedResult?.id).toBe(scoped.id);
    expect(unscopedResult?.id).toBe(unscoped.id);
    expect(unscopedResult.score).toBeGreaterThan(scopedResult.score);
  });

  it('--scope flag on remember adds scope tag', async () => {
    const out = await runHippo(['remember', 'test scope tagging', '--scope', 'design-review']);
    expect(out).toContain('scope:design-review');
  });

  it('auto-detects scope from HIPPO_SCOPE env var on remember', async () => {
    const out = await runHippo(['remember', 'auto scope test'], { HIPPO_SCOPE: 'qa' });
    expect(out).toContain('scope:qa');
  });
});
