import { execFileSync } from 'child_process';

const MAX_DIFF_TERMS = 10;

const SKIPPED_PATH_TERMS = ['src', 'dist', 'test', 'tests', 'node_modules', 'index'];

// stderr is dropped because git's warnings (line-ending notices, for one) would otherwise become query terms.
function readGit(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
}

/** A context query from the cwd's git state ('' means `getContext` lists by strength); kept out of the api layer, which never shells out. */
export function autoDetectContext(): string {
  try {
    const diff = readGit(['diff', '--name-only', 'HEAD']);

    if (diff) {
      const terms = diff
        .split('\n')
        .flatMap((f: string) => f.replace(/[/\\.]/g, ' ').split(/\s+/))
        .filter((t: string) => t.length > 2 && !SKIPPED_PATH_TERMS.includes(t))
        .slice(0, MAX_DIFF_TERMS);
      if (terms.length > 0) return terms.join(' ');
    }

    const branch = readGit(['branch', '--show-current']);

    if (branch && branch !== 'main' && branch !== 'master') {
      return branch.replace(/[-_/]/g, ' ');
    }
  } catch {
    // Not a git repo or git missing: no query, so the caller lists by strength.
  }

  return '';
}
