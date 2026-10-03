// Lesson checkers (prereg 37, 64): exit 0 pass, 1 fail, 3 na; anything else is a broken checker, never a verdict.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './exec.mjs';

export const PRE_REF = 'refs/z0/pre';
const VERDICTS = new Map([[0, 'pass'], [1, 'fail'], [3, 'na']]);
const SNAPSHOT_IDENT = {
  GIT_AUTHOR_NAME: 'z0-eval', GIT_AUTHOR_EMAIL: 'z0-eval@localhost',
  GIT_COMMITTER_NAME: 'z0-eval', GIT_COMMITTER_EMAIL: 'z0-eval@localhost',
};

export class CheckerError extends Error {
  constructor(message, stderr = '') {
    super(message);
    this.name = 'CheckerError';
    this.stderr = stderr;
  }
}

/** Run a lesson's checker on the workspace; `commands` goes to the checker as a JSON file named by Z0_COMMANDS. */
export function runCheck(lesson, { work, env, preCommit, postCommit, commands, scratch, timeoutMs = 120_000 }) {
  fs.mkdirSync(scratch, { recursive: true });
  const commandsFile = path.join(scratch, 'z0-commands.json');
  fs.writeFileSync(commandsFile, JSON.stringify(commands));
  const r = spawnSync(process.execPath, [lesson.checkPath, ...(lesson.check.args ?? [])], {
    cwd: work, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26,
    env: { ...env, Z0_PRE_COMMIT: preCommit, Z0_POST_COMMIT: postCommit, Z0_COMMANDS: commandsFile, Z0_LESSON_ID: lesson.id },
  });
  const stderr = r.stderr ?? '';
  if (r.error?.code === 'ETIMEDOUT') throw new CheckerError(`checker for lesson ${lesson.id} timed out after ${timeoutMs} ms`, stderr);
  if (r.error) throw new CheckerError(`checker for lesson ${lesson.id} did not start: ${r.error.message}`, stderr);
  const verdict = VERDICTS.get(r.status);
  if (!verdict) throw new CheckerError(`checker for lesson ${lesson.id} exited ${r.status ?? r.signal}`, stderr);
  return verdict;
}

/** The work tree as on disk (tracked and untracked, not ignored) as a commit on `parent`; HEAD, index and tree untouched. */
export function stateCommit(work, parent) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-state-'));
  const env = { ...process.env, ...SNAPSHOT_IDENT, GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    git(['read-tree', 'HEAD'], work, env);
    git(['add', '-A'], work, env);
    const tree = git(['write-tree'], work, env).trim();
    // A neutral message: the agent can see this commit through `git log --all` while the task runs.
    return git(['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', 'snapshot'], work, env).trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Hold the pre-session commit under PRE_REF so a gc during the task cannot prune it. */
export function holdPre(work, sha) {
  git(['update-ref', '--no-deref', PRE_REF, sha], work);
}

export function dropPre(work) {
  git(['update-ref', '-d', PRE_REF], work);
}
