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

function runHippo(args: string[], env?: Record<string, string>): string {
  const globalDir = path.join(tmpDir, 'global');
  return execFileSync(process.execPath, [HIPPO_JS, ...args], {
    env: { ...process.env, HIPPO_HOME: globalDir, HIPPO_SCOPE: '', GSTACK_SKILL: '', OPENCLAW_SKILL: '', ...env },
    cwd: tmpDir,
    encoding: 'utf8',
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-scope-boost-'));
  hippoDir = path.join(tmpDir, '.hippo');
  initStore(hippoDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scope boost scoring', () => {
  it('scoped memory ranks higher when scope matches', () => {
    // Create two memories with similar content but different scope tags
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

    // Recall with matching scope
    const out = runHippo(['recall', 'real DB tests', '--scope', 'plan-eng-review', '--json', '--limit', '5']);
    const parsed = JSON.parse(out);
    expect(parsed.results.length).toBeGreaterThanOrEqual(2);

    // The scoped memory should rank first (1.5x boost)
    const scopedResult = parsed.results.find((r: { id: string }) => r.id === scoped.id);
    const unscopedResult = parsed.results.find((r: { id: string }) => r.id === unscoped.id);
    expect(scopedResult).toBeDefined();
    expect(unscopedResult).toBeDefined();
    expect(scopedResult.score).toBeGreaterThan(unscopedResult.score);
  });

  it('scoped memory ranks lower when scope mismatches', () => {
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

    // Recall with mismatching scope: scoped memory gets 0.5x, unscoped gets 1.0x
    const out = runHippo(['recall', 'real DB tests', '--scope', 'qa', '--json', '--limit', '5']);
    const parsed = JSON.parse(out);
    expect(parsed.results.length).toBeGreaterThanOrEqual(2);

    const scopedResult = parsed.results.find((r: { id: string }) => r.id === scoped.id);
    const unscopedResult = parsed.results.find((r: { id: string }) => r.id === unscoped.id);
    expect(scopedResult).toBeDefined();
    expect(unscopedResult).toBeDefined();
    // Mismatched scope (0.5x) should score lower than neutral (1.0x)
    expect(unscopedResult.score).toBeGreaterThan(scopedResult.score);
  });

  it('--scope flag on remember adds scope tag', () => {
    const out = runHippo(['remember', 'test scope tagging', '--scope', 'design-review']);
    expect(out).toContain('scope:design-review');
  });

  it('auto-detects scope from HIPPO_SCOPE env var on remember', () => {
    const out = runHippo(['remember', 'auto scope test'], { HIPPO_SCOPE: 'qa' });
    expect(out).toContain('scope:qa');
  });
});
