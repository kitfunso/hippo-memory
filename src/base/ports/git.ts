// The git port: domain and api build the arguments and read the output; src/infra/git-runner.ts
// starts the process.
import { errorFields, errorMessage, log } from '../util/log.js';
import { GIT_CALL_TIMEOUT_MS } from '../util/time.js';

/** How one git call runs; each caller keeps the timeout and stderr handling its call needs. */
export interface GitCall {
  /** The folder git runs in; this process's own when absent. */
  readonly cwd?: string;
  readonly timeoutMs: number;
  /** Bytes of stdout kept before git is stopped; node's default when absent. */
  readonly maxBuffer?: number;
  /** `drop` discards git's stderr, `keep` holds it in the error only; absent, it also goes to
   * this process's stderr. */
  readonly stderr?: 'drop' | 'keep';
  /** Text written to git's stdin. */
  readonly input?: string;
}

/** git's stdout, or why it failed: `status` is the exit code, null when git was killed or never
 * started. */
export type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly status: number | null; readonly error: Error };

export interface GitRunner {
  run(args: readonly string[], call: GitCall): GitResult;
}

/** Whether `cwd` is inside a git work tree, asked through `git`; learn, churn, init and sleep
 * each check first. */
export function isGitRepo(git: GitRunner, cwd: string): boolean {
  const probe = git.run(['rev-parse', '--is-inside-work-tree'], {
    cwd,
    timeoutMs: GIT_CALL_TIMEOUT_MS,
    stderr: 'drop',
  });
  if (probe.ok) return probe.stdout.trim() === 'true';
  // Asking git about a folder that is no repo is the probe itself, so a failure is the expected
  // answer.
  log.debug(`autolearn: not a git repo: ${errorMessage(probe.error)}`, errorFields(probe.error));
  return false;
}
