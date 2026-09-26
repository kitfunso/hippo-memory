/**
 * TE5 task drafting from git history: candidate selection, the fail-at-base
 * and pass-at-fix check, and the needsReview gate the runner enforces.
 * Real git repository, real worktrees.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findCandidates, verifyCandidate, draftTasks } from '../scripts/token-eval/make-tasks.mjs';
import { validateTasks } from '../scripts/token-eval/ab-run.mjs';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repoWithHistory(): string {
  const repo = mkdtempSync(join(tmpdir(), 'make-tasks-'));
  dirs.push(repo);
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: repo, stdio: 'ignore' }); };
  git('init', '-q');
  git('config', 'user.email', 't@e');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a - b;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  // A real fix with a test that fails before it.
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'tests', 'add.test.js'), "if (require('../lib.js').add(2, 3) !== 5) process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'fix: add returned a difference');
  // Docs only: not a candidate.
  writeFileSync(join(repo, 'README.md'), 'docs\n');
  git('add', '.');
  git('commit', '-qm', 'docs');
  // Code plus a test that already passed before: a candidate that verify drops.
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\nmodule.exports.one = 1;\n');
  writeFileSync(join(repo, 'tests', 'one.test.js'), "if (require('../lib.js').add(1, 1) !== 2) process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'feat: export one');
  return repo;
}

function initRepo(repo: string): (...a: string[]) => void {
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: repo, stdio: 'ignore' }); };
  git('init', '-q');
  git('config', 'user.email', 't@e');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  return git;
}

/** A commit that touches a code file, a hidden-test fixture and an e2e spec together. */
function repoWithFixtureAndE2E(): string {
  const repo = mkdtempSync(join(tmpdir(), 'make-tasks-fixture-'));
  dirs.push(repo);
  const git = initRepo(repo);
  mkdirSync(join(repo, 'tests', 'fixtures'), { recursive: true });
  mkdirSync(join(repo, 'e2e'), { recursive: true });
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a - b;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'tests', 'add.test.js'), "require('../lib.js');\n");
  writeFileSync(join(repo, 'tests', 'fixtures', 'x.js'), 'module.exports = {};\n');
  writeFileSync(join(repo, 'e2e', 'x.spec.ts'), '// e2e\n');
  git('add', '.');
  git('commit', '-qm', 'fix: add plus fixture and e2e spec');
  return repo;
}

/** A commit that only adds an e2e spec: not a candidate, since e2e counts as neither test nor code. */
function repoWithE2EOnly(): string {
  const repo = mkdtempSync(join(tmpdir(), 'make-tasks-e2e-only-'));
  dirs.push(repo);
  const git = initRepo(repo);
  mkdirSync(join(repo, 'e2e'), { recursive: true });
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a - b;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'e2e', 'x.spec.ts'), '// e2e\n');
  git('add', '.');
  git('commit', '-qm', 'fix: add, checked only by e2e');
  return repo;
}

/** One bundle commit (5 test files) and one big-diff commit (1 test file, a large code change). */
function repoWithScopeGateCandidates(): string {
  const repo = mkdtempSync(join(tmpdir(), 'make-tasks-scope-'));
  dirs.push(repo);
  const git = initRepo(repo);
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a - b;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\n');
  for (let i = 1; i <= 5; i++) writeFileSync(join(repo, 'tests', `t${i}.test.js`), "if (require('../lib.js').add(1, 1) !== 2) process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'bundle: five test files');

  const bigBody = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join('\n');
  writeFileSync(join(repo, 'lib.js'), `${bigBody}\nmodule.exports.add = (a, b) => a + b;\n`);
  writeFileSync(join(repo, 'tests', 'big.test.js'), "if (require('../lib.js').add(1, 1) !== 2) process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'feat: big diff');

  return repo;
}

describe('make-tasks (TE5)', () => {
  it('picks commits that change code and tests, and verify keeps only real fixes', () => {
    const repo = repoWithHistory();
    const candidates = findCandidates(repo);
    expect(candidates.map((c: { subject: string }) => c.subject)).toEqual(['fix: add returned a difference', 'feat: export one']);
    expect(candidates[0].testFiles).toEqual(['tests/add.test.js']);

    const cmd = 'node {files}';
    expect(verifyCandidate(repo, candidates[0], cmd, null)).toEqual({ failsAtBase: true, passesAtFix: true, error: null });
    expect(verifyCandidate(repo, candidates[1], cmd, null)).toEqual({ failsAtBase: false, passesAtFix: true, error: null });
  });

  it('a failing setup drops the candidate with an error, not a false keep', () => {
    const repo = repoWithHistory();
    const candidates = findCandidates(repo);
    const v = verifyCandidate(repo, candidates[0], 'node {files}', 'exit 1');
    expect(v.error).toMatch(/setup failed at base/);
    expect(v.failsAtBase).toBeNull();
  });

  it('a test command that times out is an error, not a fail', () => {
    const repo = repoWithHistory();
    const candidates = findCandidates(repo);
    const hang = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const v = verifyCandidate(repo, candidates[0], hang, null, { timeoutMs: 200 });
    expect(v.error).toMatch(/timed out or was killed at base/);
    expect(v.failsAtBase).toBeNull();
  });

  it('drafts tasks that the runner refuses until reviewed', () => {
    const repo = repoWithHistory();
    const tasks = draftTasks(findCandidates(repo), { repo, cluster: 'demo', testCmd: 'node {files}', perSequence: 5 });
    expect(tasks.sequences).toHaveLength(1);
    expect(tasks.sequences[0].tasks[0]).toMatchObject({ needsReview: true, test: 'node tests/add.test.js' });
    expect(() => validateTasks(tasks)).toThrow(/needsReview/);
    for (const t of tasks.sequences[0].tasks) delete t.needsReview;
    expect(() => validateTasks(tasks)).not.toThrow();
  });

  it('a fixture is a hidden test file but not a run file; an e2e spec is neither', () => {
    const repo = repoWithFixtureAndE2E();
    const [c] = findCandidates(repo);
    expect(c.testFiles.slice().sort()).toEqual(['tests/add.test.js', 'tests/fixtures/x.js']);
    expect(c.runFiles).toEqual(['tests/add.test.js']);
  });

  it('an e2e-only commit is not a candidate', () => {
    const repo = repoWithE2EOnly();
    expect(findCandidates(repo)).toHaveLength(0);
  });

  it('the scope gate skips a bundle and a big diff, reporting why, and keeps neither', () => {
    const repo = repoWithScopeGateCandidates();
    const skips: Array<{ subject: string; reason: string }> = [];
    const candidates = findCandidates(repo, {
      maxCodeLines: 10,
      onSkip: (c: { subject: string }, reason: string) => skips.push({ subject: c.subject, reason }),
    });
    expect(candidates).toHaveLength(0);
    expect(skips).toHaveLength(2);
    expect(skips[0].subject).toBe('bundle: five test files');
    expect(skips[0].reason).toMatch(/too many runnable test files/);
    expect(skips[1].subject).toBe('feat: big diff');
    expect(skips[1].reason).toMatch(/too many changed code lines/);
  });

  it('e2e support lines do not count toward the code-lines limit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'hippo-maketasks-e2elines-'));
    dirs.push(repo);
    const git = initRepo(repo);
    mkdirSync(join(repo, 'tests'));
    mkdirSync(join(repo, 'e2e'));
    writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a - b;\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\n');
    writeFileSync(join(repo, 'tests', 'add.test.js'), "require('../lib.js');\n");
    writeFileSync(join(repo, 'e2e', 'support.js'), 'x;\n'.repeat(50));
    git('add', '.');
    git('commit', '-qm', 'fix: add, with e2e support');
    expect(findCandidates(repo, { maxCodeLines: 10 })).toHaveLength(1);
  });

  it('limits of 0 disable the scope gate', () => {
    const repo = repoWithScopeGateCandidates();
    const candidates = findCandidates(repo, { maxTestFiles: 0, maxCodeLines: 0 });
    expect(candidates.map((c: { subject: string }) => c.subject)).toEqual(['bundle: five test files', 'feat: big diff']);
  });
});
