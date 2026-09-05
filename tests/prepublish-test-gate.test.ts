import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts', 'check-tests-pass.mjs');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'prepublish-gate');

function runGate(fixture: string, env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', path.join(FIXTURES, fixture)], {
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

  test('exits 1 when the suite fails and names the escape hatch', () => {
    const r = runGate('failing');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HIPPO_PUBLISH_SKIP_TESTS');
    expect(r.stderr).toContain('onTaskUpdate');
  });

  test('a non-empty HIPPO_PUBLISH_SKIP_TESTS reason turns a failure into a warning', () => {
    const r = runGate('failing', { HIPPO_PUBLISH_SKIP_TESTS: 'flaky worker IPC, reran files alone' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).toContain('flaky worker IPC, reran files alone');
  });

  test.each(['', '   '])('HIPPO_PUBLISH_SKIP_TESTS=%j is not a reason and does not skip', (value) => {
    const r = runGate('failing', { HIPPO_PUBLISH_SKIP_TESTS: value });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to publish');
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
