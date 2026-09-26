#!/usr/bin/env node
/**
 * Draft a TE5 tasks file from a repository's own history (ROADMAP Part IX).
 *
 * A candidate task is a non-merge commit that changes at least one test file
 * and at least one non-test file: its parent is the task's base, the commit
 * is the fix, and the test files it adds or changes are the hidden tests.
 * Consecutive candidates are grouped into sequences, so later tasks can use
 * what earlier ones taught.
 *
 * Every drafted task has `needsReview: true` and a prompt that is only the
 * commit subject and body. Commit messages usually describe the fix, which
 * leaks the answer; rewrite each prompt as the problem a user would report
 * (symptom, not solution), then delete `needsReview`. ab-run.mjs refuses
 * tasks that still carry it.
 *
 * --verify checks each candidate in a scratch worktree: the hidden tests must
 * fail at the base and pass at the fix, or the task cannot tell a fix from
 * no fix. Candidates that fail the check are dropped and listed.
 *
 * Run:
 *   node scripts/token-eval/make-tasks.mjs --repo ../some-repo --cluster some-repo \
 *     --test-cmd "npx vitest run {files}" --setup "npm ci && npm run build" \
 *     [--since 2026-01-01] [--max 40] [--per-sequence 5] [--verify] > tasks.json
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TEST_PATTERN = '(^|/)(tests?|__tests__|spec)/|\\.(test|spec)\\.[cm]?[jt]sx?$|_test\\.(py|go)$|(^|/)test_[^/]*\\.py$|(^|/)conftest\\.py$';
// Fixtures and snapshots are hidden test files the fix commit still writes, not files an agent must produce.
export const DEFAULT_RUN_EXCLUDE = '(^|/)(fixtures?|__fixtures__|__snapshots__)/|(^|/)conftest\\.py$';
// e2e specs need a running app; they are neither the task's tests nor its code.
const E2E_PATTERN = /(^|\/)e2e\//;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}

/** Added + deleted lines of files outside `isTest`; binary rows (`-`) count 0. */
function codeLinesChanged(repo, parent, sha, isTest) {
  const out = git(['diff', '--numstat', '--no-renames', parent, sha], repo);
  let lines = 0;
  for (const line of out ? out.split('\n') : []) {
    if (!line) continue;
    const [added, deleted, file] = line.split('\t');
    if (isTest(file)) continue;
    lines += (added === '-' ? 0 : Number(added)) + (deleted === '-' ? 0 : Number(deleted));
  }
  return lines;
}

/** Candidate commits, oldest first, past the scope gate (fault 3: bundled commits cost no test runs). */
export function findCandidates(repo, {
  since = null,
  max = 40,
  testPattern = DEFAULT_TEST_PATTERN,
  runExclude = DEFAULT_RUN_EXCLUDE,
  maxTestFiles = 4,
  maxCodeLines = 400,
  onSkip = null,
} = {}) {
  const re = new RegExp(testPattern);
  const excludeRe = new RegExp(runExclude);
  const args = ['log', '--no-merges', '--reverse', '--format=%H%x09%P'];
  if (since) args.push(`--since=${since}`);
  const out = git(args, repo);
  const candidates = [];
  for (const line of out ? out.split('\n') : []) {
    const [sha, parents] = line.split('\t');
    const parentList = (parents ?? '').split(' ').filter(Boolean);
    if (parentList.length !== 1) continue;
    const parent = parentList[0];
    const changed = git(['diff', '--name-only', '--diff-filter=AM', parent, sha], repo).split('\n').filter(Boolean);
    const tests = changed.filter((f) => re.test(f) && !E2E_PATTERN.test(f));
    const code = git(['diff', '--name-only', parent, sha], repo).split('\n').filter((f) => f && !re.test(f) && !E2E_PATTERN.test(f));
    if (tests.length === 0 || code.length === 0) continue;
    const runFiles = tests.filter((f) => !excludeRe.test(f));
    if (runFiles.length === 0) continue;
    const candidate = {
      sha,
      parent,
      testFiles: tests,
      runFiles,
      subject: git(['log', '-1', '--format=%s', sha], repo),
      body: git(['log', '-1', '--format=%b', sha], repo),
    };
    if (maxTestFiles && runFiles.length > maxTestFiles) {
      onSkip?.(candidate, `too many runnable test files: ${runFiles.length} > ${maxTestFiles}`);
      continue;
    }
    const codeLines = codeLinesChanged(repo, parent, sha, (f) => re.test(f) || E2E_PATTERN.test(f));
    if (maxCodeLines && codeLines > maxCodeLines) {
      onSkip?.(candidate, `too many changed code lines: ${codeLines} > ${maxCodeLines}`);
      continue;
    }
    candidates.push(candidate);
  }
  return candidates.slice(-max);
}

/** Runs a check command, never throwing on a timeout or kill (status stays null). */
function run(cmd, cwd, timeoutMs) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 28 });
  return { status: r.status, stderrTail: (r.stderr ?? '').slice(-2000) };
}

/** Hidden tests fail at the base and pass at the fix, checked in a scratch worktree. */
export function verifyCandidate(repo, c, testCmd, setup, { timeoutMs = 20 * 60_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-task-verify-'));
  const cmd = testCmd.replace('{files}', c.runFiles.join(' '));
  try {
    git(['worktree', 'add', '--quiet', '--detach', dir, c.parent], repo);
    for (const f of c.testFiles) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), execFileSync('git', ['show', `${c.sha}:${f}`], { cwd: repo, maxBuffer: 1 << 28 }));
    }
    if (setup) {
      const s = run(setup, dir, timeoutMs);
      if (s.status !== 0) return { failsAtBase: null, passesAtFix: null, error: `setup failed at base (exit ${s.status}): ${s.stderrTail}` };
    }
    const atBase = run(cmd, dir, timeoutMs);
    if (atBase.status === null) return { failsAtBase: null, passesAtFix: null, error: `test command timed out or was killed at base: ${atBase.stderrTail}` };
    git(['checkout', '--quiet', '-f', c.sha], dir);
    if (setup) {
      const s = run(setup, dir, timeoutMs);
      if (s.status !== 0) return { failsAtBase: null, passesAtFix: null, error: `setup failed at fix (exit ${s.status}): ${s.stderrTail}` };
    }
    const atFix = run(cmd, dir, timeoutMs);
    if (atFix.status === null) return { failsAtBase: null, passesAtFix: null, error: `test command timed out or was killed at fix: ${atFix.stderrTail}` };
    return { failsAtBase: atBase.status !== 0, passesAtFix: atFix.status === 0, error: null };
  } finally {
    try {
      git(['worktree', 'remove', '--force', dir], repo);
    } catch {
      // A just-killed process can hold a Windows lock briefly; best-effort, never mask the result above.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`could not remove scratch worktree ${dir}: ${err.message}`);
      }
    }
  }
}

/** Group candidates into sequences and emit the tasks-file object. */
export function draftTasks(candidates, { repo, cluster, testCmd, setup = null, perSequence = 5 }) {
  const sequences = [];
  for (let i = 0; i + 1 < candidates.length; i += perSequence) {
    const chunk = candidates.slice(i, i + perSequence);
    if (chunk.length < 2) break;
    sequences.push({
      id: `${cluster}-${sequences.length + 1}`,
      cluster,
      repo,
      tasks: chunk.map((c) => {
        const runFiles = c.runFiles ?? c.testFiles;
        const task = {
          id: c.sha.slice(0, 10),
          baseRef: c.parent,
          fixRef: c.sha,
          needsReview: true,
          prompt: `${c.subject}\n\n${c.body}`.trim(),
          testFiles: c.testFiles,
          test: testCmd.replace('{files}', runFiles.join(' ')),
        };
        if (setup) task.setup = setup;
        return task;
      }),
    });
  }
  return { sequences };
}

function main() {
  const argv = process.argv;
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  // A typo must not read as 0, which would silently switch the scope gate off.
  const count = (name, fallback) => {
    const n = Number(flag(name, fallback));
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} needs a whole number >= 0`);
    return n;
  };
  const repo = flag('--repo', null);
  const testCmd = flag('--test-cmd', null);
  if (!repo || !testCmd) {
    console.error('Usage: node scripts/token-eval/make-tasks.mjs --repo PATH --cluster NAME --test-cmd "cmd {files}" [--setup CMD] [--since DATE] [--max 40] [--per-sequence 5] [--verify] [--run-exclude REGEX] [--max-test-files 4] [--max-code-lines 400]');
    process.exit(1);
  }
  const repoPath = path.resolve(repo);
  const cluster = flag('--cluster', path.basename(repoPath));
  const setup = flag('--setup', null);
  let candidates = findCandidates(repoPath, {
    since: flag('--since', null),
    max: Number(flag('--max', '40')),
    testPattern: flag('--test-pattern', DEFAULT_TEST_PATTERN),
    runExclude: flag('--run-exclude', DEFAULT_RUN_EXCLUDE),
    maxTestFiles: count('--max-test-files', '4'),
    maxCodeLines: count('--max-code-lines', '400'),
    onSkip: (c, reason) => console.error(`skipped ${c.sha.slice(0, 10)} (${c.subject}): ${reason}`),
  });
  if (argv.includes('--verify')) {
    const kept = [];
    for (const c of candidates) {
      const v = verifyCandidate(repoPath, c, testCmd, setup);
      if (!v.error && v.failsAtBase && v.passesAtFix) kept.push(c);
      else if (v.error) console.error(`dropped ${c.sha.slice(0, 10)} (${c.subject}): ${v.error}`);
      else console.error(`dropped ${c.sha.slice(0, 10)} (${c.subject}): fails at base ${v.failsAtBase}, passes at fix ${v.passesAtFix}`);
    }
    candidates = kept;
  }
  const tasks = draftTasks(candidates, { repo: repoPath, cluster, testCmd, setup, perSequence: Number(flag('--per-sequence', '5')) });
  console.error(`${candidates.length} candidate tasks in ${tasks.sequences.length} sequences. Every prompt needs review: rewrite it as the problem, not the fix, then delete "needsReview".`);
  console.log(JSON.stringify(tasks, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
