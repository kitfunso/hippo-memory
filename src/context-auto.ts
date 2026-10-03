import { execSync } from 'child_process';

const SKIPPED_PATH_TERMS = ['src', 'dist', 'test', 'tests', 'node_modules', 'index'];

/** A context query from the cwd's git state ('' means `getContext` lists by strength); kept out of the api layer, which never shells out. */
export function autoDetectContext(): string {
  try {
    const diff = execSync('git diff --name-only HEAD 2>&1', {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).trim();

    if (diff) {
      const terms = diff
        .split('\n')
        .flatMap((f: string) => f.replace(/[/\\.]/g, ' ').split(/\s+/))
        .filter((t: string) => t.length > 2 && !SKIPPED_PATH_TERMS.includes(t))
        .slice(0, 10);
      if (terms.length > 0) return terms.join(' ');
    }

    const branch = execSync('git branch --show-current 2>&1', {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).trim();

    if (branch && branch !== 'main' && branch !== 'master') {
      return branch.replace(/[-_/]/g, ' ');
    }
  } catch {
    // Not a git repo or git missing: no query, so the caller lists by strength.
  }

  return '';
}
