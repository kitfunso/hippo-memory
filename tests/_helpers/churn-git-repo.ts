// A temp git repo with dated commits, and the anchor dates the churn-staleness tests measure against.
import { execSync, execFileSync } from 'child_process';

export function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
}

export function commit(dir: string, isoDate: string, message = 'commit'): void {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
}

export const DAY = 24 * 60 * 60 * 1000;
export const ANCHOR = '2026-01-01T00:00:00.000Z';
export const BEFORE_ANCHOR = new Date(new Date(ANCHOR).getTime() - 10 * DAY).toISOString();
export const AFTER_ANCHOR = new Date(new Date(ANCHOR).getTime() + 10 * DAY).toISOString();
