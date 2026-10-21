import type { GitRunner } from '../base/ports/git.js';
import { errorFields, log } from '../base/util/log.js';
import { GIT_PROMPT_TIMEOUT_MS } from '../base/util/time.js';

const MAX_DIFF_TERMS = 10;

const SKIPPED_PATH_TERMS = ['src', 'dist', 'test', 'tests', 'node_modules', 'index'];

// stderr is dropped because git's warnings (line-ending notices, for one) would otherwise become query terms.
const GIT_READ = { timeoutMs: GIT_PROMPT_TIMEOUT_MS, stderr: 'drop' } as const;

function noQuery(error: Error): string {
  // Not a git repo, git missing or a timeout: no query, so the caller lists by strength.
  log.debug('auto context: no git-derived query', errorFields(error));
  return '';
}

function diffTerms(diff: string): string[] {
  return diff
    .split('\n')
    .flatMap((f: string) => f.replace(/[/\\.]/g, ' ').split(/\s+/))
    .filter((t: string) => t.length > 2 && !SKIPPED_PATH_TERMS.includes(t))
    .slice(0, MAX_DIFF_TERMS);
}

/** A context query from the cwd's git state ('' means `contextGet` lists by strength); the caller's `git` runs the
 * reads, since the api layer never starts a process. */
export function autoDetectContext(git: GitRunner): string {
  const diff = git.run(['diff', '--name-only', 'HEAD'], GIT_READ);
  if (!diff.ok) return noQuery(diff.error);
  const terms = diffTerms(diff.stdout.trim());
  if (terms.length > 0) return terms.join(' ');

  const branch = git.run(['branch', '--show-current'], GIT_READ);
  if (!branch.ok) return noQuery(branch.error);
  const name = branch.stdout.trim();
  return name && name !== 'main' && name !== 'master' ? name.replace(/[-_/]/g, ' ') : '';
}
