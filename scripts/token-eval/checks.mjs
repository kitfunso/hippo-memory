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

/** Runner git on the agent's workspace failed after the session: the agent broke its repo, so the cell is invalid, never the run. */
export class WorkspaceGitError extends Error {
  constructor(cause) {
    super(`runner git on the agent's workspace failed: ${cause.message.split('\n')[0]}`, { cause });
    this.name = 'WorkspaceGitError';
    this.stderr = String(cause.stderr ?? '');
  }
}

/** fn(rgit, scratch) on the workspace's own .git; only a git exit failure becomes a WorkspaceGitError, so runner bugs still throw. */
export function agentGit(work, fn) {
  // GIT_DIR pinned: with .git deleted, git would otherwise walk up to whatever repo holds the workspace.
  const gitDir = { GIT_DIR: path.join(work, '.git'), GIT_WORK_TREE: work };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-git-'));
  // A sparse checkout the agent turned on would make `add -A` skip tracked edits outside the cone.
  const rgit = (args, cwd, extra = {}) => git(['-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false', ...args], cwd, { ...gitDir, ...extra });
  try {
    return fn(rgit, scratch);
  } catch (err) {
    if (Number.isInteger(err.status) && !err.code) throw new WorkspaceGitError(err);
    throw err;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

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
  // Appended last so it wins: core.fsmonitor in the agent's .git/config names a program a checker's `git status` would run.
  const configParams = [env.GIT_CONFIG_PARAMETERS, "'core.fsmonitor=false'"].filter(Boolean).join(' ');
  const r = spawnSync(process.execPath, [lesson.checkPath, ...(lesson.check.args ?? [])], {
    cwd: work, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26,
    // A checker's git reads the workspace config alone, never the operator's global hooks or diff drivers.
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_PARAMETERS: configParams, Z0_PRE_COMMIT: preCommit, Z0_POST_COMMIT: postCommit, Z0_COMMANDS: commandsFile, Z0_LESSON_ID: lesson.id },
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
  return agentGit(work, (rgit, scratch) => {
    const env = { ...SNAPSHOT_IDENT, GIT_INDEX_FILE: path.join(scratch, 'index') };
    rgit(['read-tree', 'HEAD'], work, env);
    rgit(['add', '-A'], work, env);
    const tree = rgit(['write-tree'], work, env).trim();
    // A neutral message: the agent can see this commit through `git log --all` while the task runs.
    return rgit(['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', 'snapshot'], work, env).trim();
  });
}

/** Hold the pre-session commit under PRE_REF so a gc during the task cannot prune it. */
export function holdPre(work, sha) {
  agentGit(work, (rgit) => rgit(['update-ref', '--no-deref', PRE_REF, sha], work));
}

export function dropPre(work) {
  // After the session, so a hook the agent wrote into .git/hooks must not run here.
  agentGit(work, (rgit) => rgit(['update-ref', '-d', PRE_REF], work));
}
