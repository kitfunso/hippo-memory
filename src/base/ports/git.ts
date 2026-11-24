import { errorFields, errorMessage, log } from '../util/log.js';
import { GIT_CALL_TIMEOUT_MS } from '../util/time.js';

/** How one git call runs; each caller keeps the timeout and stderr handling its call needs. */
export interface GitCall {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxBuffer?: number;
  readonly stderr?: 'drop' | 'keep';
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
  log.debug(`autolearn: not a git repo: ${errorMessage(probe.error)}`, errorFields(probe.error));
  return false;
}
