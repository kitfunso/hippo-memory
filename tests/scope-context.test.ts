import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

let tmpDir: string;
let hippoDir: string;

function runHippo(args: string[]): string {
  const globalDir = path.join(tmpDir, 'global');
  return execFileSync(process.execPath, [HIPPO_JS, ...args], {
    env: { ...process.env, HIPPO_HOME: globalDir, HIPPO_SCOPE: '', GSTACK_SKILL: '', OPENCLAW_SKILL: '' },
    cwd: tmpDir,
    encoding: 'utf8',
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-scope-ctx-'));
  hippoDir = path.join(tmpDir, '.hippo');
  initStore(hippoDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scope-aware context injection', () => {
  it('pinned-only: scoped memory ranks higher when scope matches', () => {
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

    const out = runHippo([
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

  it('pinned-only: scoped memory ranks lower when scope mismatches', () => {
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

    const out = runHippo([
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
