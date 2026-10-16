import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { Layer } from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { runCli } from '../src/cli.js';
import { withHookStdin } from './_helpers/hook-stdin.js';
import { runInProcess } from './_helpers/run-in-process.js';

let tmpDir: string;
let hippoDir: string;

/** `hippo <args>` run in this process from tmpDir with an empty hook stdin, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function runHippo(args: string[]): Promise<string> {
  const vars = { HIPPO_HOME: path.join(tmpDir, 'global'), HIPPO_SCOPE: '', GSTACK_SKILL: '', OPENCLAW_SKILL: '' };
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  const saved = process.cwd();
  process.chdir(tmpDir);
  try {
    const r = await runInProcess(() => withHookStdin(undefined, () => runCli(['node', 'hippo', ...args])));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-scope-ctx-'));
  hippoDir = path.join(tmpDir, '.hippo');
  initStore(hippoDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scope-aware context injection', () => {
  it('pinned-only: scoped memory ranks higher when scope matches', async () => {
    const scoped = createMemory('NEVER skip DB migration in eng review', {
      layer: Layer.Episodic,
      tags: ['scope:plan-eng-review'],
      pinned: true,
      source: 'cli',
    });
    const unscoped = createMemory('NEVER skip DB migration in general', {
      layer: Layer.Episodic,
      tags: [],
      pinned: true,
      source: 'cli',
    });
    writeEntry(hippoDir, scoped);
    writeEntry(hippoDir, unscoped);

    const out = await runHippo([
      'context', '--pinned-only', '--scope', 'plan-eng-review',
      '--format', 'json', '--budget', '2000',
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.memories.length).toBeGreaterThanOrEqual(2);

    const scopedMem = parsed.memories.find((m: { id: string }) => m.id === scoped.id);
    const unscopedMem = parsed.memories.find((m: { id: string }) => m.id === unscoped.id);
    expect(scopedMem).toBeDefined();
    expect(unscopedMem).toBeDefined();
    // Scoped memory should have higher score (1.5x boost)
    expect(scopedMem.score).toBeGreaterThan(unscopedMem.score);
  });

  it('pinned-only: scoped memory ranks lower when scope mismatches', async () => {
    const scoped = createMemory('NEVER skip DB migration in eng review', {
      layer: Layer.Episodic,
      tags: ['scope:plan-eng-review'],
      pinned: true,
      source: 'cli',
    });
    const unscoped = createMemory('NEVER skip DB migration in general', {
      layer: Layer.Episodic,
      tags: [],
      pinned: true,
      source: 'cli',
    });
    writeEntry(hippoDir, scoped);
    writeEntry(hippoDir, unscoped);

    const out = await runHippo([
      'context', '--pinned-only', '--scope', 'qa',
      '--format', 'json', '--budget', '2000',
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.memories.length).toBeGreaterThanOrEqual(2);

    const scopedMem = parsed.memories.find((m: { id: string }) => m.id === scoped.id);
    const unscopedMem = parsed.memories.find((m: { id: string }) => m.id === unscoped.id);
    expect(scopedMem).toBeDefined();
    expect(unscopedMem).toBeDefined();
    // Mismatched scope (0.5x) should rank lower than neutral (1.0x)
    expect(unscopedMem.score).toBeGreaterThan(scopedMem.score);
  });
});
