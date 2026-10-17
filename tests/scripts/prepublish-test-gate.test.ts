import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'check-tests-pass.mjs');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'prepublish-gate');

function runGate(
  fixture: string,
  env: Record<string, string | undefined> = {},
  extraArgs: string[] = [],
) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', path.join(FIXTURES, fixture), ...extraArgs], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, HIPPO_PUBLISH_SKIP_TESTS: undefined, ...env },
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe('prepublish test gate (scripts/check-tests-pass.mjs)', () => {
  test('exits 0 when the suite passes', () => {
    const r = runGate('passing');
    expect(r.status, r.stderr).toBe(0);
  });

  test('exits 1 when the suite fails and names the counts', () => {
    const r = runGate('failing');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('numFailedTests=1');
    expect(r.stderr).toContain('refusing to publish');
  });

  test.each(['flaky worker IPC, reran files alone', 'i-accept-failing-tests', '1'])(
    'HIPPO_PUBLISH_SKIP_TESTS=%j does not let a red suite publish',
    (value) => {
      const r = runGate('failing', { HIPPO_PUBLISH_SKIP_TESTS: value });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('refusing to publish');
      expect(r.stderr).not.toContain('HIPPO_PUBLISH_SKIP_TESTS');
    },
  );

  // Not covered: an absent/unparseable report also fails closed; no fixture can force that shape (plan 3.3).
  test('refuses to publish when the report is green but vitest exits non-zero on a worker IPC timeout', () => {
    const r = runGate('unhandled');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('numFailedTests=0');
    expect(r.stderr).toContain('refusing to publish');
    expect(r.stderr).not.toContain('WARNING');
  });

  test('refuses to publish when the report is green but a global teardown fails', () => {
    const r = runGate('teardown');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('numPassedTests=1');
    expect(r.stderr).toContain('refusing to publish');
  });

  test('exits 1 when the suite never collects', () => {
    const r = runGate('collect');
    expect(r.status).toBe(1);
  });

  test('exits 1 when there are no test files', () => {
    const r = runGate('no-tests');
    expect(r.status).toBe(1);
  });

  test('exits 1 when the report is green but nothing actually passed', () => {
    const r = runGate('skipped');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('numPassedTests=0');
  });

  test('rejects a caller-supplied --outputFile before spawning vitest', () => {
    const r = runGate('passing', {}, ['--outputFile=/tmp/should-not-be-used.json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--outputFile');
    expect(r.stderr).toContain('reserved');
  });

  test('rejects a caller-supplied --output-file before spawning vitest', () => {
    const r = runGate('passing', {}, ['--output-file=/tmp/should-not-be-used.json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('reserved');
  });

  test('prepublishOnly keeps the three checks and build:all, then runs the gate last', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
    const chain: string = pkg.scripts.prepublishOnly;
    for (const step of [
      'node scripts/check-manifest-versions.mjs',
      'node scripts/check-em-dashes-in-release-notes.mjs',
      'node scripts/check-graph-writes.mjs',
      'npm run build:all',
    ]) {
      expect(chain).toContain(step);
    }
    expect(chain.endsWith('&& node scripts/check-tests-pass.mjs')).toBe(true);
  });
});

// The fake agent's bare `hippo` is the behaviour under test; token-eval-ab-run pins it to the run's bin/ shim.
const AGENT_STANDINS = new Set([path.join('tests', 'fixtures', 'fake-claude.mjs')]);

describe('tests run the worktree CLI, never a PATH-resolved hippo', () => {
  test('no test or benchmark helper spawns a bare `hippo` command', () => {
    // benchmarks/ holds adapters the tests import, so it is scanned too (codex round 2).
    const offenders = ['tests', 'benchmarks']
      .flatMap((dir) => readdirSync(path.join(REPO, dir), { recursive: true, encoding: 'utf-8' }).map((f) => path.join(dir, f)))
      .filter((f) => /\.(ts|mjs|js)$/.test(f))
      .filter((f) => !AGENT_STANDINS.has(f))
      .filter((f) => /(exec|spawn)\w*\(\s*[`'"]hippo\b/.test(readFileSync(path.join(REPO, f), 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
