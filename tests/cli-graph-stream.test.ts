/**
 * L1 — `hippo recall --graph-stream` CLI smoke + flag validation (real subprocess).
 * Docs: docs/plans/2026-06-02-l1-graph-rrf-stream.md
 *
 * The internal scoring-mode switch (blend -> rrf) and the graph fusion are not black-box
 * observable from CLI stdout and the rrf path needs embeddings (unavailable in CI), so the
 * mechanism is covered by the library/fusion unit tests. Here we only assert the flag is
 * wired (exits 0 on a real store) and that --graph-hops / --graph-seeds validation fires.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf-8' });
}

describe('recall --graph-stream (L1 CLI)', () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-l1cli-'));
    env = { HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(home, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('runs without error on a real store (degrades safely; stream inert without embeddings)', () => {
    hippo(home, env, 'remember', 'cache invalidation decision for the deploy pipeline');
    // Exits 0 (execFileSync throws on non-zero). Output is the normal recall result.
    const out = hippo(home, env, 'recall', 'cache', '--graph-stream', '--limit', '5');
    expect(typeof out).toBe('string');
  });

  it('--graph-hops out of range is rejected', () => {
    let err = '';
    try { hippo(home, env, 'recall', 'anything', '--graph-stream', '--graph-hops', '99'); }
    catch (e) { err = String((e as { stderr?: Buffer }).stderr ?? ''); }
    expect(err).toMatch(/Invalid --graph-hops/);
  });

  it('--graph-seeds non-positive is rejected', () => {
    let err = '';
    try { hippo(home, env, 'recall', 'anything', '--graph-stream', '--graph-seeds', '0'); }
    catch (e) { err = String((e as { stderr?: Buffer }).stderr ?? ''); }
    expect(err).toMatch(/Invalid --graph-seeds/);
  });
});
